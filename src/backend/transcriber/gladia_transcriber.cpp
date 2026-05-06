#include "core/logger.h"
#include "transcriber/gladia_transcriber.h"

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
#include <cstdio>
#include <cstdlib>
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

std::string base64_encode(const uint8_t* data, size_t len) {
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

// Remove any incomplete/invalid UTF-8 sequences from the entire string.
std::string sanitize_utf8(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    size_t i = 0;
    while (i < s.size()) {
        uint8_t c = static_cast<uint8_t>(s[i]);
        if (c < 0x80) {
            out += s[i++];
        } else if ((c & 0xE0) == 0xC0) {
            if (i + 1 < s.size() && (static_cast<uint8_t>(s[i+1]) & 0xC0) == 0x80) {
                out += s[i]; out += s[i+1]; i += 2;
            } else { i++; }
        } else if ((c & 0xF0) == 0xE0) {
            if (i + 2 < s.size() &&
                (static_cast<uint8_t>(s[i+1]) & 0xC0) == 0x80 &&
                (static_cast<uint8_t>(s[i+2]) & 0xC0) == 0x80) {
                out += s[i]; out += s[i+1]; out += s[i+2]; i += 3;
            } else { i++; }
        } else if ((c & 0xF8) == 0xF0) {
            if (i + 3 < s.size() &&
                (static_cast<uint8_t>(s[i+1]) & 0xC0) == 0x80 &&
                (static_cast<uint8_t>(s[i+2]) & 0xC0) == 0x80 &&
                (static_cast<uint8_t>(s[i+3]) & 0xC0) == 0x80) {
                out += s[i]; out += s[i+1]; out += s[i+2]; out += s[i+3]; i += 4;
            } else { i++; }
        } else {
            i++; // skip stray continuation byte or 0xFE/0xFF
        }
    }
    return out;
}

} // namespace

// ---------------------------------------------------------------------------
// Constructor / Destructor
// ---------------------------------------------------------------------------

GladiaTranscriber::GladiaTranscriber(std::string api_key, std::string model,
                                     std::string extra_config)
    : api_key_(std::move(api_key)),
      model_(std::move(model)),
      extra_config_(std::move(extra_config)) {}

GladiaTranscriber::~GladiaTranscriber() {
    should_run_.store(false);
    reconnect_requested_.store(true);
    audio_cv_.notify_all();

    intptr_t fd = sock_fd_.exchange(-1);
#ifdef _WIN32
    if (fd >= 0) ::shutdown(static_cast<SOCKET>(fd), SD_BOTH);
#else
    if (fd >= 0) ::shutdown(static_cast<int>(fd), SHUT_RDWR);
#endif

    if (io_thread_.joinable()) io_thread_.join();

    if (ssl_ctx_) {
        SSL_CTX_free(ssl_ctx_);
        ssl_ctx_ = nullptr;
    }
}

// ---------------------------------------------------------------------------
// ITranscriber interface
// ---------------------------------------------------------------------------

bool GladiaTranscriber::load_model(const std::string& /*path*/) {
    if (api_key_.empty()) {
        LOG_ERROR("Gladia: API key not set. Pass --gladia-api-key to the backend.");
        return false;
    }
    if (!should_run_.exchange(true)) {
        io_thread_ = std::thread(&GladiaTranscriber::io_thread_func, this);
    }
    return true;
}

void GladiaTranscriber::set_language(const std::string& lang) {
    {
        std::lock_guard<std::mutex> lk(lang_mutex_);
        if (language_ == lang) return;
        language_ = lang;
    }
    reconnect_requested_.store(true);
    audio_cv_.notify_all();
}

void GladiaTranscriber::feed_audio(const float* samples, size_t count) {
    if (!connected_.load()) return;

    constexpr size_t CHUNK = 1600; // 100 ms @ 16 kHz
    std::lock_guard<std::mutex> lk(audio_mutex_);

    for (size_t offset = 0; offset < count; offset += CHUNK) {
        size_t n = std::min(CHUNK, count - offset);

        if (audio_queue_.size() >= MAX_AUDIO_QUEUE) {
            audio_queue_.pop();
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

std::vector<TranscriptSegment> GladiaTranscriber::process() {
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

void GladiaTranscriber::io_thread_func() {
    while (should_run_.load()) {
        reconnect_requested_.store(false);

        // Step 1: Create session via POST
        rate_limited_.store(false);
        std::string ws_url;
        if (!init_session(ws_url)) {
            int wait_s = rate_limited_.load() ? 10 : 3;
            LOG_WARN("Gladia: session init failed, retrying in " + std::to_string(wait_s) + " s");
            for (int i = 0; i < wait_s * 10 && should_run_.load(); ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }

        // Step 2: Connect to WebSocket
        if (!connect_websocket(ws_url)) {
            LOG_WARN("Gladia: WebSocket connection failed, retrying in 3 s");
            for (int i = 0; i < 30 && should_run_.load(); ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }

        connected_.store(true);
        LOG_INFO("Gladia: WebSocket connected, streaming started");

        io_loop();

        connected_.store(false);
        close_session();
        disconnect_and_cleanup();

        if (should_run_.load() && !reconnect_requested_.load()) {
            LOG_WARN("Gladia: disconnected unexpectedly, retrying in 2 s");
            for (int i = 0; i < 20 && should_run_.load() && !reconnect_requested_.load(); ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

// ---------------------------------------------------------------------------
// TLS connection helper
// ---------------------------------------------------------------------------

bool GladiaTranscriber::tls_connect(const std::string& host, int port) {
    if (!should_run_.load()) return false;

#ifdef _WIN32
    ensure_wsa();
#endif

    struct addrinfo hints{};
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags    = AI_ADDRCONFIG;
    struct addrinfo* res = nullptr;

    if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0) {
        LOG_ERROR("Gladia: DNS lookup failed for " + host);
        return false;
    }
    if (!should_run_.load()) { freeaddrinfo(res); return false; }

    intptr_t new_fd = -1;
    for (auto* a = res; a; a = a->ai_next) {
#ifdef _WIN32
        SOCKET s = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s == INVALID_SOCKET) continue;
        DWORD timeout_ms = 10000;
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
        struct timeval tv = {10, 0};
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
        LOG_ERROR("Gladia: TCP connect to " + host + ":" + std::to_string(port) + " failed");
        return false;
    }
    sock_fd_.store(new_fd);

    if (!ssl_ctx_) {
        ssl_ctx_ = SSL_CTX_new(TLS_client_method());
        if (!ssl_ctx_) {
            LOG_ERROR("Gladia: SSL_CTX_new failed");
            disconnect_and_cleanup();
            return false;
        }
        SSL_CTX_set_min_proto_version(ssl_ctx_, TLS1_2_VERSION);
        SSL_CTX_set_verify(ssl_ctx_, SSL_VERIFY_PEER, nullptr);

        const char* cert_file = std::getenv("SSL_CERT_FILE");
        if (cert_file && cert_file[0] != '\0') {
            if (SSL_CTX_load_verify_locations(ssl_ctx_, cert_file, nullptr) == 1) {
                LOG_INFO(std::string("Gladia: loaded CA bundle from SSL_CERT_FILE=") + cert_file);
            }
        }
        SSL_CTX_set_default_verify_paths(ssl_ctx_);
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
    SSL_set_tlsext_host_name(ssl_, host.c_str());
    SSL_set1_host(ssl_, host.c_str());

    int tls_rc = SSL_connect(ssl_);
    if (tls_rc != 1) {
        int ssl_err = SSL_get_error(ssl_, tls_rc);
        unsigned long openssl_err = ERR_get_error();
        char buf[256] = {0};
        if (openssl_err != 0)
            ERR_error_string_n(openssl_err, buf, sizeof(buf));
        LOG_ERROR("Gladia: TLS handshake failed for " + host +
                  ": ssl_error=" + std::to_string(ssl_err) +
                  ", openssl=" + std::string(buf));
        disconnect_and_cleanup();
        return false;
    }

    return true;
}

// ---------------------------------------------------------------------------
// Session initialization (HTTP POST)
// ---------------------------------------------------------------------------

std::string GladiaTranscriber::build_init_body() const {
    std::string lang;
    {
        std::lock_guard<std::mutex> lk(lang_mutex_);
        lang = language_;
    }

    // Parse feature config from JSON string
    json cfg;
    if (!extra_config_.empty()) {
        try { cfg = json::parse(extra_config_); } catch (...) {}
    }

    bool code_switching       = cfg.value("code_switching", false);
    double speech_threshold   = cfg.value("speech_threshold", 0.8);
    bool audio_enhancer       = cfg.value("audio_enhancer", false);
    double endpointing        = cfg.value("endpointing", 0.01);
    double max_dur            = cfg.value("max_duration_without_endpointing", 5.0);
    bool partial_transcripts  = cfg.value("partial_transcripts", true);
    bool custom_vocab         = cfg.value("custom_vocabulary", false);
    bool custom_spell         = cfg.value("custom_spelling", false);

    json body = {
        {"encoding", "wav/pcm"},
        {"bit_depth", 16},
        {"sample_rate", SAMPLE_RATE},
        {"channels", 1},
        {"model", model_},
        {"endpointing", endpointing},
        {"maximum_duration_without_endpointing", max_dur},
        {"messages_config", {
            {"receive_partial_transcripts", partial_transcripts},
            {"receive_final_transcripts", true},
            {"receive_speech_events", true},
            {"receive_pre_processing_events", false},
            {"receive_post_processing_events", false},
            {"receive_acknowledgments", false},
            {"receive_lifecycle_events", false}
        }},
        {"pre_processing", {
            {"speech_threshold", speech_threshold},
            {"audio_enhancer", audio_enhancer}
        }},
        {"realtime_processing", json::object()},
        {"callback", false}
    };

    auto& rtp = body["realtime_processing"];
    rtp["custom_vocabulary"] = custom_vocab;
    if (custom_vocab && cfg.contains("custom_vocabulary_config")) {
        rtp["custom_vocabulary_config"] = cfg["custom_vocabulary_config"];
    }
    rtp["custom_spelling"] = custom_spell;
    if (custom_spell && cfg.contains("custom_spelling_config")) {
        rtp["custom_spelling_config"] = cfg["custom_spelling_config"];
    }

    if (lang != "auto" && !lang.empty()) {
        body["language_config"] = {
            {"languages", json::array({lang})},
            {"code_switching", code_switching}
        };
    } else {
        body["language_config"] = {
            {"languages", json::array()},
            {"code_switching", true}
        };
    }

    return body.dump();
}

bool GladiaTranscriber::init_session(std::string& ws_url) {
    if (!tls_connect("api.gladia.io", 443)) return false;

    std::string body = build_init_body();
    LOG_INFO("Gladia: POST /v2/live (model=" + model_ + ")");

    std::string req;
    req  = "POST /v2/live HTTP/1.1\r\n";
    req += "Host: api.gladia.io\r\n";
    req += "Content-Type: application/json\r\n";
    req += "x-gladia-key: " + api_key_ + "\r\n";
    req += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    req += "Connection: close\r\n";
    req += "\r\n";
    req += body;

    if (!ssl_write_all(reinterpret_cast<const uint8_t*>(req.data()), req.size())) {
        disconnect_and_cleanup();
        return false;
    }

    // Read HTTP response headers
    std::string resp;
    resp.reserve(1024);
    while (resp.size() < 16384) {
        uint8_t c;
        if (!ssl_read_exact(&c, 1)) {
            disconnect_and_cleanup();
            return false;
        }
        resp += char(c);
        if (resp.size() >= 4 &&
            resp.compare(resp.size() - 4, 4, "\r\n\r\n") == 0) break;
    }

    // Check for 2xx status
    bool status_ok = false;
    if (resp.size() >= 12) {
        // HTTP/1.1 2xx
        std::string status_code = resp.substr(9, 3);
        status_ok = (status_code[0] == '2');
    }

    // Read body based on Content-Length
    std::string response_body;
    {
        std::string lower_resp = resp;
        for (auto& ch : lower_resp) ch = static_cast<char>(std::tolower(ch));
        size_t cl = lower_resp.find("content-length: ");
        if (cl != std::string::npos) {
            size_t vs = cl + 16;
            size_t ve = resp.find('\r', vs);
            if (ve != std::string::npos) {
                int len = std::stoi(resp.substr(vs, ve - vs));
                if (len > 0 && len <= 65536) {
                    response_body.resize(len);
                    if (!ssl_read_exact(reinterpret_cast<uint8_t*>(response_body.data()), len)) {
                        disconnect_and_cleanup();
                        return false;
                    }
                }
            }
        } else {
            // No Content-Length — read until connection closes (up to 64K)
            while (response_body.size() < 65536) {
                uint8_t c;
                int r = SSL_read(ssl_, &c, 1);
                if (r <= 0) break;
                response_body += char(c);
            }
        }
    }

    disconnect_and_cleanup();

    if (!status_ok) {
        auto nl = resp.find('\r');
        std::string status_line = resp.substr(0, nl != std::string::npos ? nl : std::min(resp.size(), (size_t)200));
        rate_limited_.store(status_line.find("429") != std::string::npos);
        LOG_ERROR("Gladia: session init failed: " + status_line +
                  (response_body.empty() ? "" : " — " + response_body));
        return false;
    }

    // Parse JSON response to get WebSocket URL
    try {
        auto j = json::parse(response_body);
        if (j.contains("url")) {
            ws_url = j["url"].get<std::string>();
            std::string session_id = j.value("id", "");
            LOG_INFO("Gladia: session created (id=" + session_id + ")");
            return true;
        }
        LOG_ERROR("Gladia: response missing 'url' field: " + response_body.substr(0, 500));
        return false;
    } catch (const json::exception& e) {
        LOG_ERROR("Gladia: failed to parse session response: " + std::string(e.what()));
        return false;
    }
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

bool GladiaTranscriber::parse_wss_url(const std::string& url, ParsedUrl& out) {
    // Handle wss:// and ws://
    size_t offset = 0;
    if (url.compare(0, 6, "wss://") == 0) {
        offset = 6;
        out.port = 443;
    } else if (url.compare(0, 5, "ws://") == 0) {
        offset = 5;
        out.port = 80;
    } else {
        return false;
    }

    std::string rest = url.substr(offset);
    auto slash = rest.find('/');
    std::string host_port = (slash != std::string::npos) ? rest.substr(0, slash) : rest;
    out.path = (slash != std::string::npos) ? rest.substr(slash) : "/";

    auto colon = host_port.find(':');
    if (colon != std::string::npos) {
        out.host = host_port.substr(0, colon);
        out.port = std::stoi(host_port.substr(colon + 1));
    } else {
        out.host = host_port;
    }
    return !out.host.empty();
}

bool GladiaTranscriber::connect_websocket(const std::string& ws_url) {
    ParsedUrl parsed;
    if (!parse_wss_url(ws_url, parsed)) {
        LOG_ERROR("Gladia: failed to parse WebSocket URL: " + ws_url);
        return false;
    }

    LOG_INFO("Gladia: connecting to WebSocket at " + parsed.host + parsed.path.substr(0, 50) + "...");

    if (!tls_connect(parsed.host, parsed.port)) return false;

    // WebSocket upgrade handshake
    uint8_t key_bytes[16];
    RAND_bytes(key_bytes, 16);
    std::string ws_key = base64_encode(key_bytes, 16);

    std::string req;
    req  = "GET " + parsed.path + " HTTP/1.1\r\n";
    req += "Host: " + parsed.host + "\r\n";
    req += "Upgrade: websocket\r\n";
    req += "Connection: Upgrade\r\n";
    req += "Sec-WebSocket-Key: " + ws_key + "\r\n";
    req += "Sec-WebSocket-Version: 13\r\n";
    req += "\r\n";

    if (!ssl_write_all(reinterpret_cast<const uint8_t*>(req.data()), req.size())) {
        disconnect_and_cleanup();
        return false;
    }

    // Read HTTP 101 response
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
        LOG_ERROR("Gladia: WebSocket upgrade failed: " + status_line);
        disconnect_and_cleanup();
        return false;
    }

    return true;
}

// ---------------------------------------------------------------------------
// IO loop
// ---------------------------------------------------------------------------

void GladiaTranscriber::io_loop() {
    while (should_run_.load() && !reconnect_requested_.load()) {
        // 1. Drain audio queue → send as binary frames
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

        // 2. Check for incoming data (10 ms select timeout)
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

        while (r > 0 || (ssl_ && SSL_pending(ssl_) > 0)) {
            WsFrame frame;
            if (!ws_read_frame(frame)) return;
            handle_ws_frame(frame);

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

        // 3. Wait briefly for more audio
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
// Session & connection cleanup
// ---------------------------------------------------------------------------

void GladiaTranscriber::close_session() {
    if (!ssl_ || sock_fd_.load() < 0) return;

    // Send {"type":"stop_recording"} as text frame
    std::string stop = R"({"type":"stop_recording"})";
    {
        size_t len = stop.size();
        std::vector<uint8_t> frame(2 + 4 + len);
        size_t pos = 0;
        frame[pos++] = 0x81; // FIN + text
        frame[pos++] = 0x80 | uint8_t(len);
        uint8_t mask[4];
        RAND_bytes(mask, 4);
        std::memcpy(frame.data() + pos, mask, 4);
        pos += 4;
        for (size_t i = 0; i < len; ++i)
            frame[pos + i] = static_cast<uint8_t>(stop[i]) ^ mask[i % 4];
        ssl_write_all(frame.data(), pos + len);
    }

    // Send WebSocket close frame
    {
        uint8_t frame[6];
        frame[0] = 0x88; // FIN + close
        frame[1] = 0x80; // MASK + len=0
        RAND_bytes(frame + 2, 4);
        ssl_write_all(frame, 6);
    }

    LOG_DEBUG("Gladia: sent stop_recording + close frame");
}

void GladiaTranscriber::disconnect_and_cleanup() {
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

bool GladiaTranscriber::ws_send_binary(const uint8_t* data, size_t len) {
    size_t hdr = 2;
    if (len >= 126 && len < 65536) hdr = 4;
    else if (len >= 65536) hdr = 10;

    std::vector<uint8_t> frame(hdr + 4 + len);
    size_t pos = 0;

    frame[pos++] = 0x82; // FIN + opcode=binary

    if (len < 126) {
        frame[pos++] = 0x80 | uint8_t(len);
    } else if (len < 65536) {
        frame[pos++] = 0x80 | 126;
        frame[pos++] = uint8_t(len >> 8);
        frame[pos++] = uint8_t(len);
    } else {
        frame[pos++] = 0x80 | 127;
        for (int i = 7; i >= 0; --i)
            frame[pos++] = uint8_t(len >> (i * 8));
    }

    uint8_t mask[4];
    RAND_bytes(mask, 4);
    std::memcpy(frame.data() + pos, mask, 4);
    pos += 4;

    for (size_t i = 0; i < len; ++i)
        frame[pos + i] = data[i] ^ mask[i % 4];

    return ssl_write_all(frame.data(), pos + len);
}

bool GladiaTranscriber::ws_read_frame(WsFrame& frame) {
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
        LOG_WARN("Gladia: oversized frame (" + std::to_string(plen) + " bytes)");
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

bool GladiaTranscriber::ssl_write_all(const uint8_t* buf, size_t len) {
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

bool GladiaTranscriber::ssl_read_exact(uint8_t* buf, size_t len) {
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
            struct timeval tv = {0, 100000};
            if (select(0, &rfds, nullptr, nullptr, &tv) < 0) return false;
#else
            FD_SET(static_cast<int>(fd), &rfds);
            struct timeval tv = {0, 100000};
            if (select(static_cast<int>(fd) + 1, &rfds, nullptr, nullptr, &tv) < 0) return false;
#endif
            continue;
        }
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

void GladiaTranscriber::handle_ws_frame(const WsFrame& frame) {
    switch (frame.opcode) {
    case 0x01: // text
        handle_text_frame(std::string(frame.payload.begin(), frame.payload.end()));
        break;
    case 0x08: // close
        LOG_INFO("Gladia: server sent close frame");
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

void GladiaTranscriber::handle_text_frame(const std::string& json_str) {
    try {
        std::string safe_str = sanitize_utf8(json_str);
        auto j = json::parse(safe_str);
        std::string type = j.value("type", "");

        if (type == "transcript") {
            if (!j.contains("data")) return;
            auto& data = j["data"];
            bool is_final = data.value("is_final", false);

            if (!data.contains("utterance")) return;
            auto& utterance = data["utterance"];
            std::string text = utterance.value("text", "");
            if (text.empty()) return;

            double start_s = utterance.value("start", 0.0);
            double end_s   = utterance.value("end", 0.0);

            TranscriptSegment seg;
            seg.text       = std::move(text);
            seg.t0_ms      = static_cast<int64_t>(start_s * 1000.0);
            seg.t1_ms      = static_cast<int64_t>(end_s * 1000.0);
            seg.is_partial = !is_final;

            LOG_DEBUG("Gladia: transcript (is_final=" + std::string(is_final ? "true" : "false")
                      + "): " + seg.text.substr(0, 80));

            std::lock_guard<std::mutex> lk(result_mutex_);
            result_queue_.push(std::move(seg));

        } else if (type == "error") {
            std::string message = safe_str;
            if (j.contains("data")) {
                auto& data = j["data"];
                message = data.value("message", data.value("error", safe_str));
            }
            LOG_ERROR("Gladia: " + message);

        } else if (type == "speech_start") {
            LOG_DEBUG("Gladia: speech detected");

        } else if (type == "speech_end") {
            LOG_DEBUG("Gladia: speech ended");
        }
        // Ignore lifecycle / ack / other messages

    } catch (const json::exception& e) {
        LOG_DEBUG("Gladia: JSON parse error: " + std::string(e.what()));
    }
}

} // namespace ais
