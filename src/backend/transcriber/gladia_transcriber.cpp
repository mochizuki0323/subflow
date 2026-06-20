#include "core/logger.h"
#include "transcriber/gladia_transcriber.h"
#include "net/http_client.h"

#include <json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <vector>

using json = nlohmann::json;

namespace ais {

namespace {

// Remove any incomplete/invalid UTF-8 sequences (Gladia can split multibyte
// codepoints across frames).
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
            i++;
        }
    }
    return out;
}

} // namespace

GladiaTranscriber::GladiaTranscriber(std::string api_key, std::string model,
                                     std::string extra_config)
    : api_key_(std::move(api_key)),
      model_(std::move(model)),
      extra_config_(std::move(extra_config)) {}

GladiaTranscriber::~GladiaTranscriber() {
    running_.store(false);
    reconnect_requested_.store(true);
    state_cv_.notify_all();
    if (session_thread_.joinable()) session_thread_.join();  // joins after it tears down ws_
}

bool GladiaTranscriber::load_model(const std::string& /*path*/) {
    if (api_key_.empty()) {
        LOG_ERROR("Gladia: API key not set. Pass --gladia-api-key to the backend.");
        return false;
    }
    if (!running_.exchange(true)) {
        session_thread_ = std::thread(&GladiaTranscriber::session_thread_func, this);
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
    state_cv_.notify_all();
}

void GladiaTranscriber::feed_audio(const float* samples, size_t count) {
    if (!connected_.load() || count == 0) return;
    constexpr size_t CHUNK = 1600;  // 100 ms @ 16 kHz
    std::lock_guard<std::mutex> lk(ws_mutex_);
    if (!ws_) return;
    for (size_t offset = 0; offset < count; offset += CHUNK) {
        size_t n = std::min(CHUNK, count - offset);
        std::vector<int16_t> pcm(n);
        for (size_t i = 0; i < n; ++i) {
            float f = std::max(-1.0f, std::min(1.0f, samples[offset + i]));
            pcm[i] = static_cast<int16_t>(f * 32767.0f);
        }
        ws_->send_binary(reinterpret_cast<const uint8_t*>(pcm.data()), pcm.size() * sizeof(int16_t));
    }
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

void GladiaTranscriber::session_thread_func() {
    while (running_.load()) {
        reconnect_requested_.store(false);
        rate_limited_.store(false);

        std::string ws_url;
        if (!init_session(ws_url)) {
            int wait_s = rate_limited_.load() ? 10 : 3;
            for (int i = 0; i < wait_s * 10 && running_.load() && !reconnect_requested_.load(); ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }

        { std::lock_guard<std::mutex> lk(state_mutex_); closed_ = false; }

        net::WsClientConfig cfg;
        cfg.url = ws_url;
        cfg.auto_reconnect = false;  // single-use session URL; we re-POST on drop
        auto client = net::make_ws_client(cfg);
        client->set_on_message([this](const uint8_t* d, size_t n, bool b) { on_message(d, n, b); });
        client->set_on_state([this](net::WsState s, const std::string& det) { on_state(s, det); });
        {
            std::lock_guard<std::mutex> lk(ws_mutex_);
            ws_ = std::move(client);
            ws_->start();
        }

        // Block until the session ends (ws closed), shutdown, or language change.
        {
            std::unique_lock<std::mutex> lk(state_mutex_);
            state_cv_.wait(lk, [this] {
                return closed_ || !running_.load() || reconnect_requested_.load();
            });
        }

        // Best-effort: ask Gladia to finalize before we tear the socket down.
        {
            std::lock_guard<std::mutex> lk(ws_mutex_);
            if (ws_ && connected_.load()) ws_->send_text(R"({"type":"stop_recording"})");
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));

        std::unique_ptr<net::WsClient> old;
        { std::lock_guard<std::mutex> lk(ws_mutex_); old = std::move(ws_); }
        if (old) old->stop();
        connected_.store(false);

        if (running_.load() && !reconnect_requested_.load()) {
            LOG_WARN("Gladia: disconnected, re-initializing session in 2 s");
            for (int i = 0; i < 20 && running_.load() && !reconnect_requested_.load(); ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

bool GladiaTranscriber::init_session(std::string& ws_url) {
    net::HttpRequest req;
    req.method = "POST";
    req.url = "https://api.gladia.io/v2/live";
    req.headers["Content-Type"] = "application/json";
    req.headers["x-gladia-key"] = api_key_;
    req.body = build_init_body();
    req.timeout_ms = 15000;
    LOG_INFO("Gladia: POST /v2/live (model=" + model_ + ")");

    net::HttpResponse resp = net::http_request(req);
    if (!resp.ok) {
        LOG_ERROR("Gladia: session init transport error: " + resp.error);
        return false;
    }
    if (resp.status / 100 != 2) {
        rate_limited_.store(resp.status == 429);
        LOG_ERROR("Gladia: session init HTTP " + std::to_string(resp.status) +
                  (resp.body.empty() ? "" : " — " + resp.body));
        return false;
    }

    try {
        auto j = json::parse(resp.body);
        if (j.contains("url")) {
            ws_url = j["url"].get<std::string>();
            LOG_INFO("Gladia: session created (id=" + j.value("id", "") + ")");
            return true;
        }
        LOG_ERROR("Gladia: response missing 'url' field: " + resp.body.substr(0, 500));
    } catch (const json::exception& e) {
        LOG_ERROR("Gladia: failed to parse session response: " + std::string(e.what()));
    }
    return false;
}

std::string GladiaTranscriber::build_init_body() const {
    std::string lang;
    {
        std::lock_guard<std::mutex> lk(lang_mutex_);
        lang = language_;
    }

    json cfg;
    if (!extra_config_.empty()) {
        try { cfg = json::parse(extra_config_); } catch (...) {}
    }
    if (!cfg.is_object()) cfg = json::object();  // value() requires an object (null would throw)

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

void GladiaTranscriber::on_message(const uint8_t* data, size_t len, bool is_binary) {
    if (is_binary) return;
    handle_text_frame(std::string(reinterpret_cast<const char*>(data), len));
}

void GladiaTranscriber::on_state(net::WsState state, const std::string& detail) {
    switch (state) {
        case net::WsState::Open:
            connected_.store(true);
            LOG_INFO("Gladia: WebSocket connected, streaming started");
            break;
        case net::WsState::Connecting:
            break;
        case net::WsState::Closed:
        case net::WsState::Error:
            connected_.store(false);
            if (state == net::WsState::Error) LOG_WARN("Gladia: connection error (" + detail + ")");
            { std::lock_guard<std::mutex> lk(state_mutex_); closed_ = true; }
            state_cv_.notify_all();
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

    } catch (const json::exception& e) {
        LOG_DEBUG("Gladia: JSON parse error: " + std::string(e.what()));
    }
}

} // namespace ais
