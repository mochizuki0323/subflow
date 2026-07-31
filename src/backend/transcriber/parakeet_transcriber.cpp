#include "transcriber/parakeet_transcriber.h"
#include "core/logger.h"
#include <sherpa-onnx/c-api/c-api.h>
#include <cstring>
#include <filesystem>

namespace ais {

struct ParakeetTranscriber::Impl {
    const SherpaOnnxOfflineRecognizer* recognizer = nullptr;
    const SherpaOnnxVoiceActivityDetector* vad = nullptr;
};

ParakeetTranscriber::ParakeetTranscriber(std::string model_dir,
                                         std::string model_type,
                                         std::string vad_model,
                                         VadParams params)
    : model_dir_(std::move(model_dir)),
      model_type_(std::move(model_type)),
      vad_model_path_(std::move(vad_model)),
      impl_(new Impl) {
    params_ = params;
}

ParakeetTranscriber::~ParakeetTranscriber() {
    running_ = false;
    queue_cv_.notify_all();
    if (decode_thread_.joinable()) decode_thread_.join();

    if (impl_->vad) SherpaOnnxDestroyVoiceActivityDetector(impl_->vad);
    if (impl_->recognizer) SherpaOnnxDestroyOfflineRecognizer(impl_->recognizer);
    delete impl_;
}

std::string ParakeetTranscriber::resolve_file(const std::string& name) const {
    namespace fs = std::filesystem;
    auto p = fs::path(model_dir_) / name;
    if (fs::exists(p)) return p.string();
    return name;
}

bool ParakeetTranscriber::create_recognizer() {
    SherpaOnnxOfflineRecognizerConfig config;
    std::memset(&config, 0, sizeof(config));

    config.feat_config.sample_rate = SAMPLE_RATE;
    config.feat_config.feature_dim = 80;
    config.decoding_method = "greedy_search";

    std::string tokens_path = resolve_file("tokens.txt");
    config.model_config.tokens = tokens_path.c_str();
    config.model_config.num_threads = 4;
    config.model_config.provider = "cpu";
    config.model_config.debug = 0;

    std::string model_type_str = model_type_;
    config.model_config.model_type = model_type_str.c_str();

    std::string encoder_path, decoder_path, joiner_path, model_path;

    if (model_type_ == "nemo_ctc") {
        model_path = resolve_file("model.int8.onnx");
        config.model_config.nemo_ctc.model = model_path.c_str();
        LOG_INFO("Parakeet CTC model: " + model_path);
    } else {
        encoder_path = resolve_file("encoder.int8.onnx");
        decoder_path = resolve_file("decoder.int8.onnx");
        joiner_path = resolve_file("joiner.int8.onnx");
        config.model_config.transducer.encoder = encoder_path.c_str();
        config.model_config.transducer.decoder = decoder_path.c_str();
        config.model_config.transducer.joiner = joiner_path.c_str();
        LOG_INFO("Parakeet transducer model: " + encoder_path);
    }

    LOG_INFO("Creating offline recognizer (type=" + model_type_ + ")...");

    impl_->recognizer = SherpaOnnxCreateOfflineRecognizer(&config);
    if (!impl_->recognizer) {
        LOG_ERROR("Failed to create Parakeet recognizer from: " + model_dir_);
        return false;
    }

    LOG_INFO("Parakeet recognizer created successfully");
    return true;
}

bool ParakeetTranscriber::create_vad() {
    if (vad_model_path_.empty()) {
        LOG_ERROR("VAD model path not set");
        return false;
    }

    SherpaOnnxVadModelConfig vad_config;
    std::memset(&vad_config, 0, sizeof(vad_config));

    vad_config.silero_vad.model = vad_model_path_.c_str();
    vad_config.silero_vad.threshold = params_.threshold;
    vad_config.silero_vad.min_silence_duration = params_.min_silence;
    vad_config.silero_vad.min_speech_duration = params_.min_speech;
    vad_config.silero_vad.max_speech_duration = params_.max_speech;
    vad_config.silero_vad.window_size = VAD_WINDOW;
    vad_config.sample_rate = SAMPLE_RATE;
    vad_config.num_threads = 1;
    vad_config.provider = "cpu";
    vad_config.debug = 0;

    impl_->vad = SherpaOnnxCreateVoiceActivityDetector(&vad_config, 30.0f);
    if (!impl_->vad) {
        LOG_ERROR("Failed to create Silero VAD from: " + vad_model_path_);
        return false;
    }

    LOG_INFO("Silero VAD loaded: " + vad_model_path_);
    return true;
}

void ParakeetTranscriber::rebuild_vad() {
    if (impl_->vad) {
        SherpaOnnxDestroyVoiceActivityDetector(impl_->vad);
        impl_->vad = nullptr;
    }
    speech_buf_.clear();
    vad_remainder_.clear();
    if (create_vad()) {
        LOG_INFO("VAD rebuilt with updated parameters");
    } else {
        LOG_ERROR("Failed to rebuild VAD with updated parameters");
    }
    last_partial_time_ = clock::now();
}

void ParakeetTranscriber::set_vad_params(const VadParams& params) {
    {
        std::lock_guard<std::mutex> lk(vad_params_mutex_);
        pending_params_ = params;
    }
    vad_dirty_.store(true);

    char buf[160];
    std::snprintf(buf, sizeof(buf),
        "VAD params queued: thr=%.2f minSil=%.2fs minSpe=%.2fs maxSpe=%.1fs partial=%.2fs",
        params.threshold, params.min_silence, params.min_speech,
        params.max_speech, params.partial_interval);
    LOG_INFO(buf);
}

std::string ParakeetTranscriber::decode_buffer(const float* samples, int32_t n) {
    if (n <= 0) return {};

    const auto* stream = SherpaOnnxCreateOfflineStream(impl_->recognizer);
    if (!stream) return {};

    SherpaOnnxAcceptWaveformOffline(stream, SAMPLE_RATE, samples, n);
    SherpaOnnxDecodeOfflineStream(impl_->recognizer, stream);

    std::string text;
    const auto* result = SherpaOnnxGetOfflineStreamResult(stream);
    if (result && result->text && result->text[0] != '\0') {
        text = result->text;
        auto s = text.find_first_not_of(" \t\n\r");
        auto e = text.find_last_not_of(" \t\n\r");
        if (s != std::string::npos) {
            text = text.substr(s, e - s + 1);
        } else {
            text.clear();
        }
    }
    if (result) SherpaOnnxDestroyOfflineRecognizerResult(result);
    SherpaOnnxDestroyOfflineStream(stream);
    return text;
}

// ---- Decode thread ----

void ParakeetTranscriber::decode_thread_func() {
    LOG_INFO("Parakeet decode thread started");

    while (running_.load()) {
        DecodeRequest req;
        bool have_final = false;
        bool have_partial = false;

        {
            std::unique_lock<std::mutex> lk(queue_mutex_);
            queue_cv_.wait_for(lk, std::chrono::milliseconds(50), [this] {
                return !running_.load() || !final_queue_.empty() || partial_ready_;
            });

            if (!running_.load()) break;

            if (!final_queue_.empty()) {
                req = std::move(final_queue_.front());
                final_queue_.pop();
                have_final = true;
            } else if (partial_ready_) {
                req = std::move(partial_snapshot_);
                partial_snapshot_ = {};
                partial_ready_ = false;
                have_partial = true;
            }
        }

        if (!have_final && !have_partial) continue;

        auto t_start = clock::now();
        std::string text = decode_buffer(
            req.samples.data(), static_cast<int32_t>(req.samples.size()));
        auto t_end = clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            t_end - t_start).count();
        float audio_sec = static_cast<float>(req.samples.size()) / SAMPLE_RATE;

        if (!text.empty()) {
            int64_t t0 = (req.t0_sample * 1000) / SAMPLE_RATE;
            int64_t t1 = (req.t1_sample * 1000) / SAMPLE_RATE;

            TranscriptSegment seg;
            seg.text = std::move(text);
            seg.t0_ms = t0;
            seg.t1_ms = t1;
            seg.is_partial = !req.is_final;
            seg.latency_ms = req.queued_at.time_since_epoch().count() == 0
                ? -1
                : std::chrono::duration_cast<std::chrono::milliseconds>(
                      t_end - req.queued_at).count();

            if (req.is_final) {
                char buf[128];
                std::snprintf(buf, sizeof(buf),
                    "Parakeet final: %.1fs in %lldms (RTF=%.3f): ",
                    audio_sec, (long long)ms,
                    audio_sec > 0 ? static_cast<float>(ms) / (audio_sec * 1000.0f) : 0.0f);
                LOG_INFO(std::string(buf) + seg.text);
            }

            std::lock_guard<std::mutex> lk(result_mutex_);
            result_queue_.push_back(std::move(seg));
        }
    }

    LOG_INFO("Parakeet decode thread stopped");
}

// ---- Public interface (called from pipeline thread) ----

bool ParakeetTranscriber::load_model(const std::string& /*path*/) {
    if (loaded_.load()) return true;
    if (model_dir_.empty()) {
        LOG_WARN("Parakeet model directory not set");
        return false;
    }

    if (!create_vad()) return false;
    if (!create_recognizer()) return false;

    loaded_ = true;
    running_ = true;
    last_partial_time_ = clock::now();
    decode_thread_ = std::thread([this]() { decode_thread_func(); });
    return true;
}

void ParakeetTranscriber::set_language(const std::string& lang) {
    language_ = lang;
}

void ParakeetTranscriber::feed_audio(const float* samples, size_t count) {
    if (!loaded_.load() || count == 0) return;
    std::lock_guard<std::mutex> lock(audio_mutex_);
    audio_pending_.insert(audio_pending_.end(), samples, samples + count);
}

std::vector<TranscriptSegment> ParakeetTranscriber::process() {
    if (!loaded_.load()) return {};

    // Apply any pending VAD parameter change on the pipeline thread, where the
    // VAD object is owned, so it is never destroyed while in use elsewhere.
    if (vad_dirty_.exchange(false)) {
        {
            std::lock_guard<std::mutex> lk(vad_params_mutex_);
            params_ = pending_params_;
        }
        rebuild_vad();
    }

    // Drain results from decode thread
    std::vector<TranscriptSegment> results;
    {
        std::lock_guard<std::mutex> lk(result_mutex_);
        if (!result_queue_.empty()) {
            results = std::move(result_queue_);
            result_queue_.clear();
        }
    }

    // Move pending audio into local buffer, prepend leftover from last call
    std::vector<float> incoming;
    {
        std::lock_guard<std::mutex> lock(audio_mutex_);
        if (audio_pending_.empty() && vad_remainder_.empty()) return results;
        if (!vad_remainder_.empty()) {
            incoming = std::move(vad_remainder_);
            vad_remainder_.clear();
        }
        incoming.insert(incoming.end(), audio_pending_.begin(), audio_pending_.end());
        audio_pending_.clear();
    }

    // Feed audio to VAD in window_size chunks
    size_t offset = 0;
    while (offset + VAD_WINDOW <= incoming.size()) {
        SherpaOnnxVoiceActivityDetectorAcceptWaveform(
            impl_->vad, incoming.data() + offset, VAD_WINDOW);
        global_sample_count_ += VAD_WINDOW;
        offset += VAD_WINDOW;

        if (SherpaOnnxVoiceActivityDetectorDetected(impl_->vad)) {
            // Accumulate into speech buffer while VAD detects speech
            if (speech_buf_.empty()) {
                segment_start_sample_ = global_sample_count_ - VAD_WINDOW;
            }
            speech_buf_.insert(speech_buf_.end(),
                               incoming.data() + offset - VAD_WINDOW,
                               incoming.data() + offset);
        } else if (!speech_buf_.empty()) {
            // VAD dropped back to non-speech without producing a segment:
            // speech was too short (< min_speech_duration), discard as false positive
            speech_buf_.clear();
        }

        // Check for completed speech segments
        while (!SherpaOnnxVoiceActivityDetectorEmpty(impl_->vad)) {
            const auto* seg = SherpaOnnxVoiceActivityDetectorFront(impl_->vad);
            if (seg) {
                if (seg->samples && seg->n > 0) {
                    DecodeRequest req;
                    req.samples.assign(seg->samples, seg->samples + seg->n);
                    req.queued_at = clock::now();
                    req.t0_sample = static_cast<int64_t>(seg->start);
                    req.t1_sample = static_cast<int64_t>(seg->start) + seg->n;
                    req.is_final = true;

                    {
                        std::lock_guard<std::mutex> lk(queue_mutex_);
                        final_queue_.push(std::move(req));
                    }
                    queue_cv_.notify_one();
                }
                SherpaOnnxDestroySpeechSegment(seg);
            }
            SherpaOnnxVoiceActivityDetectorPop(impl_->vad);

            speech_buf_.clear();
            last_partial_time_ = clock::now();
        }
    }

    // Stash leftover samples (< window_size) for the next process() call
    if (offset < incoming.size()) {
        vad_remainder_.assign(incoming.data() + offset,
                              incoming.data() + incoming.size());
    }

    // Queue a partial decode snapshot if enough time has elapsed
    if (!speech_buf_.empty() &&
        SherpaOnnxVoiceActivityDetectorDetected(impl_->vad)) {

        auto now = clock::now();
        float elapsed = std::chrono::duration<float>(now - last_partial_time_).count();

        if (elapsed >= params_.partial_interval) {
            last_partial_time_ = now;

            DecodeRequest req;
            req.samples = speech_buf_;
            req.queued_at = clock::now();
            req.t0_sample = segment_start_sample_;
            req.t1_sample = global_sample_count_;
            req.is_final = false;

            {
                std::lock_guard<std::mutex> lk(queue_mutex_);
                partial_snapshot_ = std::move(req);
                partial_ready_ = true;
            }
            queue_cv_.notify_one();
        }
    }

    return results;
}

} // namespace ais
