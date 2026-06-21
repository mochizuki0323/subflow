#include "transcriber/remote_parakeet_transcriber.h"
#include "core/logger.h"

#include <json.hpp>

#include <utility>

namespace ais {

using json = nlohmann::json;

RemoteParakeetTranscriber::RemoteParakeetTranscriber(std::string url, std::string api_key,
                                                     std::string model, ParakeetVadParams vad)
    : url_(std::move(url)), api_key_(std::move(api_key)), model_(std::move(model)), vad_(vad) {}

RemoteParakeetTranscriber::~RemoteParakeetTranscriber() {
    if (ws_) ws_->stop();
}

bool RemoteParakeetTranscriber::load_model(const std::string& /*path*/) {
    if (url_.empty()) {
        LOG_ERROR("Remote Parakeet: server URL not set");
        return false;
    }
    net::WsClientConfig cfg;
    cfg.url = url_;
    // Select the server-side model via a query param. Model ids are plain folder
    // names (alphanumerics / '-' / '.'), so no escaping is needed.
    if (!model_.empty()) {
        if (url_.find('?') != std::string::npos) {
            cfg.url += "&model=" + model_;
        } else {
            // The query must sit after a path: "ws://host:port" → ".../?model=…".
            // A query glued straight onto the port (".../:port?model") would be
            // parsed as part of the port and break host/port resolution.
            auto auth = url_.find("://");
            auth = (auth == std::string::npos) ? 0 : auth + 3;
            const bool has_path = url_.find('/', auth) != std::string::npos;
            cfg.url += (has_path ? "?model=" : "/?model=") + model_;
        }
    }
    if (!api_key_.empty()) cfg.headers["Authorization"] = "Bearer " + api_key_;
    cfg.auto_reconnect = true;

    ws_ = net::make_ws_client(cfg);
    ws_->set_on_message([this](const uint8_t* d, size_t n, bool bin) { on_message(d, n, bin); });
    ws_->set_on_state([this](net::WsState s, const std::string& det) { on_state(s, det); });
    ws_->start();
    LOG_INFO("Remote Parakeet: connecting to " + cfg.url);
    return true;
}

void RemoteParakeetTranscriber::set_language(const std::string& lang) {
    language_ = lang;
    if (ws_ && connected_.load()) {
        json j = {{"type", "set_language"}, {"data", {{"language", lang}}}};
        ws_->send_text(j.dump());
    }
}

void RemoteParakeetTranscriber::set_vad_params(const ParakeetVadParams& params) {
    {
        std::lock_guard<std::mutex> lk(vad_mutex_);
        vad_ = params;
    }
    send_vad_params();
}

void RemoteParakeetTranscriber::send_vad_params() {
    if (!ws_ || !connected_.load()) return;  // re-sent on (re)connect via on_state
    ParakeetVadParams p;
    {
        std::lock_guard<std::mutex> lk(vad_mutex_);
        p = vad_;
    }
    json j = {{"type", "set_vad"}, {"data", {
        {"threshold", p.threshold},
        {"min_silence", p.min_silence},
        {"min_speech", p.min_speech},
        {"max_speech", p.max_speech},
        {"partial_interval", p.partial_interval},
    }}};
    ws_->send_text(j.dump());
}

void RemoteParakeetTranscriber::feed_audio(const float* samples, size_t count) {
    if (!ws_ || !connected_.load() || count == 0) return;
    // 16 kHz mono int16 little-endian (both ends are x86/ARM little-endian).
    std::vector<int16_t> pcm(count);
    for (size_t i = 0; i < count; ++i) {
        float v = samples[i] * 32768.0f;
        if (v > 32767.0f) v = 32767.0f;
        else if (v < -32768.0f) v = -32768.0f;
        pcm[i] = static_cast<int16_t>(v);
    }
    ws_->send_binary(reinterpret_cast<const uint8_t*>(pcm.data()), pcm.size() * sizeof(int16_t));
}

std::vector<TranscriptSegment> RemoteParakeetTranscriber::process() {
    std::vector<TranscriptSegment> out;
    std::lock_guard<std::mutex> lk(result_mutex_);
    if (!result_queue_.empty()) {
        out = std::move(result_queue_);
        result_queue_.clear();
    }
    return out;
}

void RemoteParakeetTranscriber::on_message(const uint8_t* data, size_t len, bool is_binary) {
    if (is_binary) return;  // server only sends JSON text frames
    try {
        json m = json::parse(std::string(reinterpret_cast<const char*>(data), len));
        const std::string type = m.value("type", "");
        if (type == "transcript") {
            TranscriptSegment seg;
            seg.text = m.value("text", "");
            seg.t0_ms = m.value("t0", static_cast<int64_t>(0));
            seg.t1_ms = m.value("t1", static_cast<int64_t>(0));
            seg.is_partial = m.value("partial", false);
            if (!seg.text.empty()) {
                std::lock_guard<std::mutex> lk(result_mutex_);
                result_queue_.push_back(std::move(seg));
            }
        } else if (type == "error") {
            LOG_WARN("Remote Parakeet server error: " + m.value("message", std::string{}));
        }
    } catch (const json::exception& e) {
        LOG_WARN(std::string("Remote Parakeet: malformed message: ") + e.what());
    }
}

void RemoteParakeetTranscriber::on_state(net::WsState state, const std::string& detail) {
    switch (state) {
        case net::WsState::Open:
            connected_ = true;
            LOG_INFO("Remote Parakeet: connected");
            if (language_ != "auto") set_language(language_);
            send_vad_params();  // push this client's VAD tuning to the server session
            break;
        case net::WsState::Connecting:
            break;
        case net::WsState::Closed:
            if (connected_.exchange(false)) LOG_INFO("Remote Parakeet: disconnected");
            break;
        case net::WsState::Error:
            if (connected_.exchange(false)) LOG_WARN("Remote Parakeet: connection error (" + detail + ")");
            else LOG_WARN("Remote Parakeet: connection failed (" + detail + ")");
            break;
    }
}

} // namespace ais
