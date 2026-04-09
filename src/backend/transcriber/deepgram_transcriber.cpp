#include "core/logger.h"
#include "transcriber/deepgram_transcriber.h"

#include <json.hpp>
#include <openssl/err.h>
#include <openssl/rand.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include "core/win32_undef_error.h"
#else
#include <sys/socket.h>
#include <sys/select.h>
#include <netdb.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <mutex>

using json = nlohmann::json;

namespace ais {

namespace {

#ifdef _WIN32
void ensure_wsa() {
    static std::once_flag once;
    std::call_once(once, [] {
        WSADATA wsa;
        WSAStartup(MAKEWORD(2, 2), &wsa);
    });
}
#endif

} // namespace

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static std::string base64_encode(const uint8_t* data, size_t len) {
    static const char T[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t b = uint32_t(data[i]) << 16;
        if (i + 1 < len) b |= uint32_t(data[i + 1]) << 8;
        if (i + 2 < len) b |= uint32_t(data[i + 2]);
        out += T[(b >> 18) & 0x3F];
        out += T[(b >> 12) & 0x3F];
        out += (i + 1 < len) ? T[(b >> 6) & 0x3F] : '=';
        out += (i + 2 < len) ? T[b & 0x3F]        : '=';
    }
    return out;
}

// Map internal language codes to Deepgram BCP-47 language tags.
static std::string to_deepgram_lang(const std::string& lang) {
    if (lang == "en" || lang == "en-us") return "en-US";
    if (lang == "zh")                    return "zh-CN";
    return lang; // ja, ko, de, fr, es, pt, ru, etc. pass through as-is
}

// ---------------------------------------------------------------------------
// Constructor / Destructor
// ---------------------------------------------------------------------------

DeepgramTranscriber::DeepgramTranscriber(std::string api_key,
                                         std::string model,
                                         std::string extra_params)
    : api_key_(std::move(api_key)),
      model_(std::move(model)),
      extra_params_(std::move(extra_params)) {}

DeepgramTranscriber::~DeepgramTranscriber() {
    should_run_.store(false);
    reconnect_requested_.store(true);
    audio_cv_.notify_all();

    // Interrupt any blocking SSL read by shutting down the socket.
    intptr_t fd = sock_fd_.exchange(-1);
#ifdef _WIN32
    if (fd >= 0) ::shutdown(static_cast<SOCKET>(fd), SD_BOTH);
#else
    if (fd >= 0) ::shutdown(static_cast<int>(fd), SHUT_RDWR);
#endif

    if (io_thread_.joinable()) io_thread_.join();

    // io_thread_ has exited and owns ssl_ cleanup; only ssl_ctx_ remains.
    if (ssl_ctx_) {
        SSL_CTX_free(ssl_ctx_);
        ssl_ctx_ = nullptr;
    }
}

// ---------------------------------------------------------------------------
// ITranscriber interface
// ---------------------------------------------------------------------------

bool DeepgramTranscriber::load_model(const std::string& /*path*/) {
    if (api_key_.empty()) {
        LOG_ERROR("Deepgram: API key not set. Pass --api-key to the backend.");
        return false;
    }
    // Start io_thread_ only once.
    if (!should_run_.exchange(true)) {
        io_thread_ = std::thread(&DeepgramTranscriber::io_thread_func, this);
    }
    return true;
}

void DeepgramTranscriber::set_language(const std::string& lang) {
    {
        std::lock_guard<std::mutex> lk(lang_mutex_);
        if (language_ == lang) return;
        language_ = lang;
    }
    // Trigger reconnect with new language.
    reconnect_requested_.store(true);
    audio_cv_.notify_all();
}

void DeepgramTranscriber::feed_audio(const float* samples, size_t count) {
    if (!connected_.load()) return;

    // Convert float32 PCM → int16 and split into 100 ms chunks.
    constexpr size_t CHUNK = 1600; // 100 ms @ 16 kHz
    std::lock_guard<std::mutex> lk(audio_mutex_);

    for (size_t offset = 0; offset < count; offset += CHUNK) {
        size_t n = std::min(CHUNK, count - offset);

        if (audio_queue_.size() >= MAX_AUDIO_QUEUE) {
            audio_queue_.pop(); // Drop oldest to avoid unbounded memory
        }

        std::vector<int16_t> chunk(n);
        for (size_t i = 0; i < n; ++i) {
            float f = std::max(-1.0f, std::min(1.0f, samples[offset + i]));
            chunk[i] = static_cast<int16_t>(f * 32767.0f);
        }
        audio_queue_.push(std::move(chunk));
    }
    audio_cv_.notify_all();
}

std::vector<TranscriptSegment> DeepgramTranscriber::process() {
    std::vector<TranscriptSegment> out;
    std::lock_guard<std::mutex> lk(result_mutex_);
    while (!result_queue_.empty()) {
        out.push_back(std::move(result_queue_.front()));
        result_queue_.pop();
    }
    return out;
}

// ---------------------------------------------------------------------------
// IO thread lifecycle
// ---------------------------------------------------------------------------

void DeepgramTranscriber::io_thread_func() {
    while (should_run_.load()) {
        reconnect_requested_.store(false);

        if (!connect_and_handshake()) {
            LOG_WARN("Deepgram: connection failed, retrying in 3 s");
            for (int i = 0; i < 30 && should_run_.load(); ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }

        connected_.store(true);
        LOG_INFO("Deepgram: WebSocket connected, streaming started");

        io_loop();

        connected_.store(false);
        disconnect_and_cleanup();

        if (should_run_.load() && !reconnect_requested_.load()) {
            LOG_WARN("Deepgram: disconnected unexpectedly, retrying in 2 s");
            for (int i = 0; i < 20 && should_run_.load() && !reconnect_requested_.load(); ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        // If reconnect_requested_, loop immediately.
    }
}

void DeepgramTranscriber::io_loop() {
    while (should_run_.load() && !reconnect_requested_.load()) {
        // 1. Drain audio queue → send to Deepgram.
        {
            std::unique_lock<std::mutex> lk(audio_mutex_);
            while (!audio_queue_.empty() && should_run_.load()) {
                auto chunk = std::move(audio_queue_.front());
                audio_queue_.pop();
                lk.unlock();

                if (!ws_send_binary(
                        reinterpret_cast<const uint8_t*>(chunk.data()),
                        chunk.size() * sizeof(int16_t))) {
                    return;
                }
                lk.lock();
            }
        }

        // 2. Check for incoming data (10 ms select timeout).
        intptr_t fd = sock_fd_.load();
        if (fd < 0) return;
#ifdef _WIN32
        SOCKET win_sock = static_cast<SOCKET>(fd);
#endif

        fd_set rfds;
        FD_ZERO(&rfds);
#ifdef _WIN32
        FD_SET(win_sock, &rfds);
#else
        FD_SET(static_cast<int>(fd), &rfds);
#endif
        struct timeval tv = {0, 10000};
#ifdef _WIN32
        int r = select(0, &rfds, nullptr, nullptr, &tv);
#else
        int r = select(static_cast<int>(fd) + 1, &rfds, nullptr, nullptr, &tv);
#endif
        if (r < 0) return;

        // Drain all buffered frames.
        while (r > 0 || (ssl_ && SSL_pending(ssl_) > 0)) {
            WsFrame frame;
            if (!ws_read_frame(frame)) return;
            handle_ws_frame(frame);

            // Re-check without blocking.
            if (ssl_ && SSL_pending(ssl_) > 0) {
                r = 1;
            } else {
                FD_ZERO(&rfds);
#ifdef _WIN32
                FD_SET(win_sock, &rfds);
#else
                FD_SET(static_cast<int>(fd), &rfds);
#endif
                struct timeval tv2 = {0, 0};
#ifdef _WIN32
                r = select(0, &rfds, nullptr, nullptr, &tv2);
#else
                r = select(static_cast<int>(fd) + 1, &rfds, nullptr, nullptr, &tv2);
#endif
                if (r <= 0) break;
            }
        }
        if (r < 0) return;

        // 3. If nothing pending, wait briefly for more audio.
        {
            std::unique_lock<std::mutex> lk(audio_mutex_);
            if (audio_queue_.empty()) {
                audio_cv_.wait_for(lk, std::chrono::milliseconds(5), [this] {
                    return !audio_queue_.empty()
                        || !should_run_.load()
                        || reconnect_requested_.load();
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

bool DeepgramTranscriber::connect_and_handshake() {
    if (!should_run_.load()) return false;

#ifdef _WIN32
    ensure_wsa();
#endif

    // --- TCP connect ---
    struct addrinfo hints{};
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags    = AI_ADDRCONFIG;
    struct addrinfo* res = nullptr;

    if (getaddrinfo("api.deepgram.com", "443", &hints, &res) != 0) {
        LOG_ERROR("Deepgram: DNS lookup failed");
        return false;
    }
    if (!should_run_.load()) { freeaddrinfo(res); return false; }

    intptr_t new_fd = -1;
    for (auto* a = res; a; a = a->ai_next) {
#ifdef _WIN32
        SOCKET s = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s == INVALID_SOCKET) continue;

        // Winsock expects integer milliseconds for SO_*TIMEO (not struct timeval).
        DWORD timeout_ms = 10000; // 10 s
        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms));
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms));

        if (::connect(s, a->ai_addr, static_cast<int>(a->ai_addrlen)) != SOCKET_ERROR) {
            new_fd = static_cast<intptr_t>(s);
            break;
        }
        ::closesocket(s);
#else
        int s = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s < 0) continue;

        struct timeval tv = {10, 0}; // 10 s connect timeout
        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        if (::connect(s, a->ai_addr, a->ai_addrlen) == 0) {
            new_fd = s;
            break;
        }
        ::close(s);
#endif
    }
    freeaddrinfo(res);

    if (new_fd < 0) {
        LOG_ERROR("Deepgram: TCP connect to api.deepgram.com:443 failed");
        return false;
    }
    sock_fd_.store(new_fd);

    // --- TLS ---
    if (!ssl_ctx_) {
        ssl_ctx_ = SSL_CTX_new(TLS_client_method());
        if (!ssl_ctx_) {
            LOG_ERROR("Deepgram: SSL_CTX_new failed");
            disconnect_and_cleanup();
            return false;
        }
        SSL_CTX_set_min_proto_version(ssl_ctx_, TLS1_2_VERSION);
        SSL_CTX_set_verify(ssl_ctx_, SSL_VERIFY_PEER, nullptr);

        const char* cert_file = std::getenv("SSL_CERT_FILE");
        if (cert_file && cert_file[0] != '\0') {
            if (SSL_CTX_load_verify_locations(ssl_ctx_, cert_file, nullptr) == 1) {
                LOG_INFO(std::string("Deepgram: loaded CA bundle from SSL_CERT_FILE=") + cert_file);
            } else {
                char buf[256];
                ERR_error_string_n(ERR_get_error(), buf, sizeof(buf));
                LOG_WARN(std::string("Deepgram: failed to load SSL_CERT_FILE (") + cert_file + "): " + buf);
            }
        }

        if (SSL_CTX_set_default_verify_paths(ssl_ctx_) != 1) {
            char buf[256];
            ERR_error_string_n(ERR_get_error(), buf, sizeof(buf));
            LOG_WARN("Deepgram: SSL_CTX_set_default_verify_paths failed: " + std::string(buf));
        }
    }

    ssl_ = SSL_new(ssl_ctx_);
    if (!ssl_) {
        disconnect_and_cleanup();
        return false;
    }
#ifdef _WIN32
    SSL_set_fd(ssl_, static_cast<int>(static_cast<SOCKET>(new_fd)));
#else
    SSL_set_fd(ssl_, static_cast<int>(new_fd));
#endif
    SSL_set_tlsext_host_name(ssl_, "api.deepgram.com");
    SSL_set1_host(ssl_, "api.deepgram.com");

    int tls_rc = SSL_connect(ssl_);
    if (tls_rc != 1) {
        int ssl_err = SSL_get_error(ssl_, tls_rc);
        unsigned long openssl_err = ERR_get_error();
        char buf[256] = {0};
        if (openssl_err != 0) {
            ERR_error_string_n(openssl_err, buf, sizeof(buf));
        } else {
            std::snprintf(buf, sizeof(buf), "(no OpenSSL error on queue)");
        }

        long verify_rc = SSL_get_verify_result(ssl_);
#ifdef _WIN32
        int os_err = WSAGetLastError();
        LOG_ERROR("Deepgram: TLS handshake failed: ssl_error=" + std::to_string(ssl_err) +
                  ", verify_result=" + std::to_string(verify_rc) +
                  ", wsa_error=" + std::to_string(os_err) +
                  ", openssl=" + std::string(buf));
#else
        int os_err = errno;
        LOG_ERROR("Deepgram: TLS handshake failed: ssl_error=" + std::to_string(ssl_err) +
                  ", verify_result=" + std::to_string(verify_rc) +
                  ", errno=" + std::to_string(os_err) +
                  ", openssl=" + std::string(buf));
#endif
        disconnect_and_cleanup();
        return false;
    }

    // --- WebSocket upgrade ---
    uint8_t key_bytes[16];
    RAND_bytes(key_bytes, 16);
    std::string ws_key = base64_encode(key_bytes, 16);

    std::string url = build_ws_url();
    LOG_INFO("Deepgram: GET " + url);

    std::string req;
    req  = "GET " + url + " HTTP/1.1\r\n";
    req += "Host: api.deepgram.com\r\n";
    req += "Upgrade: websocket\r\n";
    req += "Connection: Upgrade\r\n";
    req += "Sec-WebSocket-Key: " + ws_key + "\r\n";
    req += "Sec-WebSocket-Version: 13\r\n";
    req += "Authorization: Token " + api_key_ + "\r\n";
    req += "\r\n";

    if (!ssl_write_all(reinterpret_cast<const uint8_t*>(req.data()), req.size())) {
        disconnect_and_cleanup();
        return false;
    }

    // Read HTTP 101 response.
    std::string resp;
    resp.reserve(512);
    while (resp.size() < 8192) {
        uint8_t c;
        if (!ssl_read_exact(&c, 1)) {
            disconnect_and_cleanup();
            return false;
        }
        resp += char(c);
        if (resp.size() >= 4 &&
                resp.compare(resp.size() - 4, 4, "\r\n\r\n") == 0) break;
    }

    if (resp.find("101") == std::string::npos) {
        auto nl = resp.find('\r');
        std::string status_line = resp.substr(0, nl != std::string::npos ? nl : std::min(resp.size(), (size_t)200));

        // Try to read response body for detailed error message
        std::string body;
        {
            // Look for Content-Length header
            std::string lower_resp = resp;
            for (auto& c : lower_resp) c = std::tolower(c);
            size_t cl = lower_resp.find("content-length: ");
            if (cl != std::string::npos) {
                size_t vs = cl + 16;
                size_t ve = resp.find('\r', vs);
                if (ve != std::string::npos) {
                    int len = std::stoi(resp.substr(vs, ve - vs));
                    if (len > 0 && len <= 4096) {
                        body.resize(len);
                        ssl_read_exact(reinterpret_cast<uint8_t*>(body.data()), len);
                    }
                }
            }
        }

        LOG_ERROR("Deepgram: WebSocket upgrade failed: " + status_line +
                  (body.empty() ? "" : " — " + body));
        disconnect_and_cleanup();
        return false;
    }

    return true;
}

void DeepgramTranscriber::disconnect_and_cleanup() {
    if (ssl_) {
        SSL_free(ssl_);
        ssl_ = nullptr;
    }
    intptr_t fd = sock_fd_.exchange(-1);
#ifdef _WIN32
    if (fd >= 0) ::closesocket(static_cast<SOCKET>(fd));
#else
    if (fd >= 0) ::close(static_cast<int>(fd));
#endif
}

// ---------------------------------------------------------------------------
// WebSocket frame I/O
// ---------------------------------------------------------------------------

bool DeepgramTranscriber::ws_send_binary(const uint8_t* data, size_t len) {
    std::vector<uint8_t> frame;
    frame.reserve(10 + len);

    frame.push_back(0x82); // FIN + opcode=binary

    if (len < 126) {
        frame.push_back(0x80 | uint8_t(len));
    } else if (len < 65536) {
        frame.push_back(0x80 | 126);
        frame.push_back(uint8_t(len >> 8));
        frame.push_back(uint8_t(len));
    } else {
        frame.push_back(0x80 | 127);
        for (int i = 7; i >= 0; --i)
            frame.push_back(uint8_t(len >> (i * 8)));
    }

    uint8_t mask[4];
    RAND_bytes(mask, 4);
    frame.insert(frame.end(), mask, mask + 4);

    for (size_t i = 0; i < len; ++i)
        frame.push_back(data[i] ^ mask[i % 4]);

    return ssl_write_all(frame.data(), frame.size());
}

bool DeepgramTranscriber::ws_read_frame(WsFrame& frame) {
    uint8_t hdr[2];
    if (!ssl_read_exact(hdr, 2)) return false;

    frame.opcode = hdr[0] & 0x0F;
    bool masked  = (hdr[1] >> 7) & 1;
    uint64_t plen = hdr[1] & 0x7F;

    if (plen == 126) {
        uint8_t ext[2];
        if (!ssl_read_exact(ext, 2)) return false;
        plen = (uint64_t(ext[0]) << 8) | ext[1];
    } else if (plen == 127) {
        uint8_t ext[8];
        if (!ssl_read_exact(ext, 8)) return false;
        plen = 0;
        for (int i = 0; i < 8; ++i) plen = (plen << 8) | ext[i];
    }

    if (plen > 10ULL * 1024 * 1024) {
        LOG_WARN("Deepgram: oversized frame (" + std::to_string(plen) + " bytes)");
        return false;
    }

    uint8_t mask[4] = {};
    if (masked && !ssl_read_exact(mask, 4)) return false;

    frame.payload.resize(plen);
    if (plen > 0) {
        if (!ssl_read_exact(frame.payload.data(), plen)) return false;
        if (masked)
            for (size_t i = 0; i < plen; ++i)
                frame.payload[i] ^= mask[i % 4];
    }
    return true;
}

bool DeepgramTranscriber::ssl_write_all(const uint8_t* buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        int r = SSL_write(ssl_, buf + sent, int(len - sent));
        if (r > 0) { sent += r; continue; }

        int err = SSL_get_error(ssl_, r);
        if (err == SSL_ERROR_WANT_WRITE) {
            intptr_t fd = sock_fd_.load();
            if (fd < 0) return false;
            fd_set wfds;
            FD_ZERO(&wfds);
#ifdef _WIN32
            FD_SET(static_cast<SOCKET>(fd), &wfds);
            struct timeval tv = {1, 0};
            if (select(0, nullptr, &wfds, nullptr, &tv) <= 0) return false;
#else
            FD_SET(static_cast<int>(fd), &wfds);
            struct timeval tv = {1, 0};
            if (select(static_cast<int>(fd) + 1, nullptr, &wfds, nullptr, &tv) <= 0) return false;
#endif
            continue;
        }
        return false;
    }
    return true;
}

bool DeepgramTranscriber::ssl_read_exact(uint8_t* buf, size_t len) {
    size_t got = 0;
    while (got < len) {
        if (!should_run_.load() || reconnect_requested_.load()) return false;

        int r = SSL_read(ssl_, buf + got, int(len - got));
        if (r > 0) { got += r; continue; }

        int err = SSL_get_error(ssl_, r);
        if (err == SSL_ERROR_WANT_READ) {
            intptr_t fd = sock_fd_.load();
            if (fd < 0) return false;
            fd_set rfds;
            FD_ZERO(&rfds);
#ifdef _WIN32
            FD_SET(static_cast<SOCKET>(fd), &rfds);
            struct timeval tv = {0, 100000}; // 100 ms
            if (select(0, &rfds, nullptr, nullptr, &tv) < 0) return false;
#else
            FD_SET(static_cast<int>(fd), &rfds);
            struct timeval tv = {0, 100000}; // 100 ms
            if (select(static_cast<int>(fd) + 1, &rfds, nullptr, nullptr, &tv) < 0) return false;
#endif
            // timeout: loop and re-check should_run_ / reconnect_requested_
            continue;
        }
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// URL / frame parsing
// ---------------------------------------------------------------------------

std::string DeepgramTranscriber::build_ws_url() const {
    std::string lang;
    {
        std::lock_guard<std::mutex> lk(lang_mutex_);
        lang = language_;
    }

    // Base URL: only the required transport parameters.
    // All Deepgram feature params (interim_results, punctuate, etc.) come from extra_params_.
    std::string url = "/v1/listen?encoding=linear16&sample_rate=16000";
    url += "&model=" + model_;

    // For "auto", omit language param and let Deepgram default to English.
    // detect_language=true has limited model support and may cause 400 errors.
    if (lang != "auto" && !lang.empty()) {
        url += "&language=" + to_deepgram_lang(lang);
    }
    if (!extra_params_.empty()) {
        url += "&" + extra_params_;
    }
    return url;
}

void DeepgramTranscriber::handle_ws_frame(const WsFrame& frame) {
    switch (frame.opcode) {
    case 0x01: // text
        handle_text_frame(std::string(frame.payload.begin(), frame.payload.end()));
        break;
    case 0x08: // close
        LOG_INFO("Deepgram: server sent close frame");
        break;
    case 0x09: { // ping → pong
        std::vector<uint8_t> pong;
        pong.push_back(0x8A); // FIN + pong
        pong.push_back(0x80); // MASK + len=0
        uint8_t mask[4]; RAND_bytes(mask, 4);
        pong.insert(pong.end(), mask, mask + 4);
        ssl_write_all(pong.data(), pong.size());
        break;
    }
    default:
        break;
    }
}

void DeepgramTranscriber::handle_text_frame(const std::string& json_str) {
    try {
        auto j = json::parse(json_str);
        std::string type = j.value("type", "");

        if (type == "Metadata") {
            LOG_INFO("Deepgram: session started (request_id=" +
                     j.value("request_id", "") + ")");
            return;
        }
        if (type == "SpeechStarted") {
            LOG_INFO("Deepgram: speech detected (VAD triggered)");
            return;
        }
        if (type == "UtteranceEnd") {
            LOG_DEBUG("Deepgram: utterance end");
            return;
        }
        if (type == "Error") {
            LOG_ERROR("Deepgram: " + j.value("description", json_str));
            return;
        }
        if (type != "Results") return;

        bool   is_final  = j.value("is_final", false);
        double start_s   = j.value("start",    0.0);
        double dur_s     = j.value("duration", 0.0);

        if (!j.contains("channel")) return;
        auto& ch = j["channel"];
        if (!ch.contains("alternatives") || ch["alternatives"].empty()) return;

        auto& alt = ch["alternatives"][0];
        std::string full_text = alt.value("transcript", "");
        if (full_text.empty()) {
            LOG_DEBUG("Deepgram: empty transcript (is_final=" +
                      std::string(is_final ? "true" : "false") + ")");
            return;
        }

        // If diarization words are present, reconstruct per-speaker segments.
        std::vector<TranscriptSegment> segs;
        if (alt.contains("words") && !alt["words"].empty()) {
            auto& words = alt["words"];
            bool has_speaker_field = words[0].contains("speaker");
            LOG_DEBUG("Deepgram: words[0]=" + words[0].dump()
                      + " has_speaker=" + (has_speaker_field ? "yes" : "no")
                      + " is_final=" + (is_final ? "true" : "false"));
            int   cur_speaker = words[0].value("speaker", -1);
            double seg_start  = words[0].value("start", start_s);
            double seg_end    = seg_start;
            std::string seg_text;

            for (auto& w : words) {
                int    spk  = w.value("speaker", -1);
                double ws   = w.value("start", 0.0);
                double we   = w.value("end",   0.0);
                std::string wt = w.value("word", "");

                if (spk != cur_speaker && !seg_text.empty()) {
                    // Flush current speaker segment
                    TranscriptSegment seg;
                    seg.text       = seg_text;
                    seg.t0_ms      = static_cast<int64_t>(seg_start * 1000.0);
                    seg.t1_ms      = static_cast<int64_t>(seg_end   * 1000.0);
                    seg.is_partial = !is_final;
                    seg.speaker    = cur_speaker;
                    segs.push_back(std::move(seg));
                    seg_text.clear();
                    cur_speaker = spk;
                    seg_start   = ws;
                }
                if (!seg_text.empty()) seg_text += ' ';
                seg_text += wt;
                seg_end = we;
            }

            // Flush last group
            if (!seg_text.empty()) {
                TranscriptSegment seg;
                seg.text       = seg_text;
                seg.t0_ms      = static_cast<int64_t>(seg_start * 1000.0);
                seg.t1_ms      = static_cast<int64_t>(seg_end   * 1000.0);
                seg.is_partial = !is_final;
                seg.speaker    = cur_speaker;
                segs.push_back(std::move(seg));
            }
        } else {
            // No words array (diarization off) — single segment, no speaker.
            TranscriptSegment seg;
            seg.text       = std::move(full_text);
            seg.t0_ms      = static_cast<int64_t>(start_s * 1000.0);
            seg.t1_ms      = static_cast<int64_t>((start_s + dur_s) * 1000.0);
            seg.is_partial = !is_final;
            segs.push_back(std::move(seg));
        }

        std::lock_guard<std::mutex> lk(result_mutex_);
        for (auto& seg : segs)
            result_queue_.push(std::move(seg));

    } catch (const json::exception& e) {
        LOG_DEBUG("Deepgram: JSON parse error: " + std::string(e.what()));
    }
}

} // namespace ais
