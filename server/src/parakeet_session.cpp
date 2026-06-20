#include "parakeet_session.h"
#include "log.h"

#include <sherpa-onnx/c-api/c-api.h>

#include <cstring>
#include <utility>

namespace ais {

ParakeetSession::ParakeetSession(uint64_t id, DecodeScheduler& scheduler,
                                 std::string vad_model_path, ServerVadParams vad_params,
                                 TranscriptCallback on_transcript)
    : id_(id), scheduler_(scheduler), vad_model_path_(std::move(vad_model_path)),
      params_(vad_params), on_transcript_(std::move(on_transcript)) {}

ParakeetSession::~ParakeetSession() {
    stop();
    if (vad_) SherpaOnnxDestroyVoiceActivityDetector(vad_);
}

bool ParakeetSession::create_vad() {
    if (vad_model_path_.empty()) {
        LOG_ERROR("ParakeetSession: VAD model path not set");
        return false;
    }
    SherpaOnnxVadModelConfig cfg;
    std::memset(&cfg, 0, sizeof(cfg));
    cfg.silero_vad.model = vad_model_path_.c_str();
    cfg.silero_vad.threshold = params_.threshold;
    cfg.silero_vad.min_silence_duration = params_.min_silence;
    cfg.silero_vad.min_speech_duration = params_.min_speech;
    cfg.silero_vad.max_speech_duration = params_.max_speech;
    cfg.silero_vad.window_size = kVadWindow;
    cfg.sample_rate = kSampleRate;
    cfg.num_threads = 1;
    cfg.provider = "cpu";
    cfg.debug = 0;

    vad_ = SherpaOnnxCreateVoiceActivityDetector(&cfg, 30.0f);
    if (!vad_) {
        LOG_ERROR("ParakeetSession: failed to create Silero VAD from " + vad_model_path_);
        return false;
    }
    return true;
}

bool ParakeetSession::start() {
    if (running_.load()) return true;
    if (!create_vad()) return false;
    running_ = true;
    last_partial_time_ = std::chrono::steady_clock::now();
    worker_ = std::thread([this] { worker_loop(); });
    return true;
}

void ParakeetSession::stop() {
    if (!running_.exchange(false)) {
        if (worker_.joinable()) worker_.join();
        return;
    }
    audio_cv_.notify_all();
    if (worker_.joinable()) worker_.join();
    scheduler_.drop_session(id_);
}

void ParakeetSession::feed_audio(const float* samples, size_t count) {
    if (!running_.load() || count == 0) return;
    {
        std::lock_guard<std::mutex> lk(audio_mutex_);
        audio_pending_.insert(audio_pending_.end(), samples, samples + count);
    }
    audio_cv_.notify_one();
}

DecodeScheduler::ResultSink ParakeetSession::make_sink() {
    std::weak_ptr<ParakeetSession> self = weak_from_this();
    return [self](const std::string& text, int64_t t0_ms, int64_t t1_ms, bool is_final) {
        if (auto s = self.lock()) {
            if (s->on_transcript_) s->on_transcript_(text, t0_ms, t1_ms, is_final);
        }
    };
}

void ParakeetSession::worker_loop() {
    while (running_.load()) {
        std::vector<float> incoming;
        {
            std::unique_lock<std::mutex> lk(audio_mutex_);
            audio_cv_.wait_for(lk, std::chrono::milliseconds(20), [this] {
                return !running_.load() || !audio_pending_.empty();
            });
            if (!running_.load()) break;
            if (audio_pending_.empty()) continue;
            incoming.swap(audio_pending_);
        }
        // Prepend leftover (< one VAD window) from the previous batch.
        if (!vad_remainder_.empty()) {
            incoming.insert(incoming.begin(), vad_remainder_.begin(), vad_remainder_.end());
            vad_remainder_.clear();
        }
        process_audio(incoming);
    }
}

void ParakeetSession::process_audio(std::vector<float>& incoming) {
    size_t offset = 0;
    while (offset + kVadWindow <= incoming.size()) {
        SherpaOnnxVoiceActivityDetectorAcceptWaveform(vad_, incoming.data() + offset, kVadWindow);
        global_sample_count_ += kVadWindow;
        offset += kVadWindow;

        if (SherpaOnnxVoiceActivityDetectorDetected(vad_)) {
            if (speech_buf_.empty()) segment_start_sample_ = global_sample_count_ - kVadWindow;
            speech_buf_.insert(speech_buf_.end(),
                               incoming.data() + offset - kVadWindow, incoming.data() + offset);
        } else if (!speech_buf_.empty()) {
            // Speech too short to form a segment — discard as false positive.
            speech_buf_.clear();
        }

        // Drain any completed speech segments → final decode.
        while (!SherpaOnnxVoiceActivityDetectorEmpty(vad_)) {
            const auto* seg = SherpaOnnxVoiceActivityDetectorFront(vad_);
            if (seg) {
                if (seg->samples && seg->n > 0) {
                    int64_t t0 = (static_cast<int64_t>(seg->start) * 1000) / kSampleRate;
                    int64_t t1 = ((static_cast<int64_t>(seg->start) + seg->n) * 1000) / kSampleRate;
                    std::vector<float> samples(seg->samples, seg->samples + seg->n);
                    scheduler_.submit_final(id_, std::move(samples), t0, t1, make_sink());
                }
                SherpaOnnxDestroySpeechSegment(seg);
            }
            SherpaOnnxVoiceActivityDetectorPop(vad_);
            speech_buf_.clear();
            last_partial_time_ = std::chrono::steady_clock::now();
        }
    }

    // Stash leftover (< one window) for next batch.
    if (offset < incoming.size()) {
        vad_remainder_.assign(incoming.data() + offset, incoming.data() + incoming.size());
    }

    // Periodic interim (partial) re-decode of the in-progress speech buffer.
    if (!speech_buf_.empty() && SherpaOnnxVoiceActivityDetectorDetected(vad_)) {
        auto now = std::chrono::steady_clock::now();
        float elapsed = std::chrono::duration<float>(now - last_partial_time_).count();
        if (elapsed >= params_.partial_interval) {
            last_partial_time_ = now;
            int64_t t0 = (segment_start_sample_ * 1000) / kSampleRate;
            int64_t t1 = (global_sample_count_ * 1000) / kSampleRate;
            std::vector<float> samples = speech_buf_;
            scheduler_.submit_partial(id_, std::move(samples), t0, t1, make_sink());
        }
    }
}

} // namespace ais
