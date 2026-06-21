#include "core/logger.h"
#include "transcriber/deepgram_transcriber.h"

#include <json.hpp>

#include <algorithm>
#include <cstdint>
#include <vector>

using json = nlohmann::json;

namespace ais {

namespace {

// Map internal language codes to Deepgram BCP-47 language tags.
std::string to_deepgram_lang(const std::string& lang) {
    if (lang == "en" || lang == "en-us") return "en-US";
    if (lang == "zh")                    return "zh-CN";
    return lang; // ja, ko, de, fr, es, pt, ru, etc. pass through as-is
}

} // namespace

DeepgramTranscriber::DeepgramTranscriber(std::string api_key,
                                         std::string model,
                                         std::string extra_params)
    : api_key_(std::move(api_key)),
      model_(std::move(model)),
      extra_params_(std::move(extra_params)) {}

DeepgramTranscriber::~DeepgramTranscriber() {
    running_.store(false);
    std::unique_ptr<net::WsClient> old;
    { std::lock_guard<std::mutex> lk(ws_mutex_); old = std::move(ws_); }
    if (old) old->stop();
}

bool DeepgramTranscriber::load_model(const std::string& /*path*/) {
    if (api_key_.empty()) {
        LOG_ERROR("Deepgram: API key not set. Pass --api-key to the backend.");
        return false;
    }
    running_.store(true);
    connect();
    return true;
}

void DeepgramTranscriber::set_language(const std::string& lang) {
    {
        std::lock_guard<std::mutex> lk(lang_mutex_);
        if (language_ == lang) return;
        language_ = lang;
    }
    // Deepgram embeds the language in the connection URL, so a change requires a reconnect.
    if (running_.load()) connect();
}

void DeepgramTranscriber::connect() {
    const std::string url = build_ws_url();
    LOG_INFO("Deepgram: connecting " + url);

    net::WsClientConfig cfg;
    cfg.url = url;
    cfg.headers["Authorization"] = "Token " + api_key_;
    cfg.auto_reconnect = true;

    auto client = net::make_ws_client(cfg);
    client->set_on_message([this](const uint8_t* d, size_t n, bool bin) { on_message(d, n, bin); });
    client->set_on_state([this](net::WsState s, const std::string& det) { on_state(s, det); });

    std::unique_ptr<net::WsClient> old;
    {
        std::lock_guard<std::mutex> lk(ws_mutex_);
        old = std::move(ws_);
        ws_ = std::move(client);
    }
    if (old) old->stop();   // stop the previous connection outside the lock
    std::lock_guard<std::mutex> lk(ws_mutex_);
    if (ws_) ws_->start();
}

void DeepgramTranscriber::feed_audio(const float* samples, size_t count) {
    if (!connected_.load() || count == 0) return;
    // float32 → int16, streamed in 100 ms frames.
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

std::vector<TranscriptSegment> DeepgramTranscriber::process() {
    std::vector<TranscriptSegment> out;
    std::lock_guard<std::mutex> lk(result_mutex_);
    while (!result_queue_.empty()) {
        out.push_back(std::move(result_queue_.front()));
        result_queue_.pop();
    }
    return out;
}

std::string DeepgramTranscriber::build_ws_url() const {
    std::string lang;
    {
        std::lock_guard<std::mutex> lk(lang_mutex_);
        lang = language_;
    }
    // Only the required transport params here; feature params come from extra_params_.
    std::string url = "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000";
    url += "&model=" + model_;
    if (lang != "auto" && !lang.empty()) {
        url += "&language=" + to_deepgram_lang(lang);
    }
    if (!extra_params_.empty()) {
        url += "&" + extra_params_;
    }
    return url;
}

void DeepgramTranscriber::on_message(const uint8_t* data, size_t len, bool is_binary) {
    if (is_binary) return;
    handle_text_frame(std::string(reinterpret_cast<const char*>(data), len));
}

void DeepgramTranscriber::on_state(net::WsState state, const std::string& detail) {
    switch (state) {
        case net::WsState::Open:
            connected_.store(true);
            LOG_INFO("Deepgram: WebSocket connected, streaming started");
            break;
        case net::WsState::Connecting:
            break;
        case net::WsState::Closed:
            connected_.store(false);
            break;
        case net::WsState::Error:
            connected_.store(false);
            LOG_WARN("Deepgram: connection error (" + detail + ")");
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
