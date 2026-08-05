#include "transcriber/nemotron_transcriber.h"
#include "core/logger.h"
#include <sherpa-onnx/c-api/c-api.h>
#include <cstdio>
#include <cstring>
#include <filesystem>

namespace ais {

struct NemotronTranscriber::Impl {
    const SherpaOnnxOnlineRecognizer* recognizer = nullptr;
    const SherpaOnnxOnlineStream* stream = nullptr;
};

NemotronTranscriber::NemotronTranscriber(std::string model_dir, EndpointParams params)
    : model_dir_(std::move(model_dir)),
      params_(params),
      impl_(new Impl) {}

NemotronTranscriber::~NemotronTranscriber() {
    {
        // The decode thread's wait has no timeout, so the flag must flip under
        // the same mutex the predicate reads. Flipping it outside can land
        // between the predicate check and the block — the notify below is then
        // lost and join() never returns. (The Parakeet twin tolerates the
        // unlocked write only because its wait re-checks every 50 ms.)
        std::lock_guard<std::mutex> lk(audio_mutex_);
        running_ = false;
    }
    audio_cv_.notify_all();
    if (decode_thread_.joinable()) decode_thread_.join();

    if (impl_->stream) SherpaOnnxDestroyOnlineStream(impl_->stream);
    if (impl_->recognizer) SherpaOnnxDestroyOnlineRecognizer(impl_->recognizer);
    delete impl_;
}

std::string NemotronTranscriber::resolve_file(const std::string& name) const {
    namespace fs = std::filesystem;
    auto p = fs::path(model_dir_) / name;
    if (fs::exists(p)) return p.string();
    return name;
}

bool NemotronTranscriber::create_recognizer() {
    SherpaOnnxOnlineRecognizerConfig config;
    std::memset(&config, 0, sizeof(config));

    config.feat_config.sample_rate = SAMPLE_RATE;
    config.feat_config.feature_dim = FEATURE_DIM;

    std::string encoder_path = resolve_file("encoder.int8.onnx");
    std::string decoder_path = resolve_file("decoder.int8.onnx");
    std::string joiner_path = resolve_file("joiner.int8.onnx");
    std::string tokens_path = resolve_file("tokens.txt");

    config.model_config.transducer.encoder = encoder_path.c_str();
    config.model_config.transducer.decoder = decoder_path.c_str();
    config.model_config.transducer.joiner = joiner_path.c_str();
    config.model_config.tokens = tokens_path.c_str();
    config.model_config.num_threads = params_.num_threads;
    config.model_config.provider = "cpu";
    config.model_config.debug = 0;
    // Left NULL on purpose: sherpa reads the variant out of the encoder's ONNX
    // metadata. Naming it here would only be a second place to get it wrong
    // when a future export changes the string.
    config.model_config.model_type = nullptr;

    // These models ship greedy search only — modified_beam_search and hotwords
    // are not implemented for them upstream.
    config.decoding_method = "greedy_search";

    config.enable_endpoint = 1;
    config.rule1_min_trailing_silence = params_.min_trailing_silence;
    config.rule2_min_trailing_silence = params_.min_trailing_silence_after;
    config.rule3_min_utterance_length = params_.max_utterance;

    LOG_INFO("Creating streaming Nemotron recognizer from: " + model_dir_
             + " (threads=" + std::to_string(params_.num_threads) + ")");

    impl_->recognizer = SherpaOnnxCreateOnlineRecognizer(&config);
    if (!impl_->recognizer) {
        LOG_ERROR("Failed to create Nemotron recognizer from: " + model_dir_);
        return false;
    }

    impl_->stream = SherpaOnnxCreateOnlineStream(impl_->recognizer);
    if (!impl_->stream) {
        LOG_ERROR("Failed to create Nemotron stream");
        SherpaOnnxDestroyOnlineRecognizer(impl_->recognizer);
        impl_->recognizer = nullptr;
        return false;
    }

    LOG_INFO("Nemotron recognizer created successfully");
    return true;
}

// Must run on the decode thread: the option lives on the stream, which only
// that thread may touch.
void NemotronTranscriber::apply_language() {
    std::string want;
    {
        std::lock_guard<std::mutex> lk(lang_mutex_);
        want = language_.empty() ? "auto" : language_;
    }
    if (want == applied_language_) return;
    SherpaOnnxOnlineStreamSetOption(impl_->stream, "language", want.c_str());
    applied_language_ = want;
    LOG_INFO("Nemotron language: " + want);
}

void NemotronTranscriber::decode_thread_func() {
    LOG_INFO("Nemotron decode thread started");

    while (running_.load()) {
        std::vector<float> chunk;
        clock::time_point arrived{};
        {
            std::unique_lock<std::mutex> lk(audio_mutex_);
            audio_cv_.wait(lk, [this] {
                return !running_.load() || !audio_pending_.empty();
            });
            if (!running_.load()) break;
            chunk.swap(audio_pending_);
            // The wait this batch endured is over; whatever arrives next starts
            // its own clock. Leaving the stamp set would make every later batch
            // report its age from the first sample ever fed, and since the queue
            // is rarely empty mid-speech it would never have been cleared.
            arrived = pending_since_;
            pending_since_ = clock::time_point{};
        }

        if (lang_dirty_.exchange(false)) apply_language();

        SherpaOnnxOnlineStreamAcceptWaveform(
            impl_->stream, SAMPLE_RATE, chunk.data(),
            static_cast<int32_t>(chunk.size()));
        global_sample_count_ += static_cast<int64_t>(chunk.size());

        while (SherpaOnnxIsOnlineStreamReady(impl_->recognizer, impl_->stream)) {
            SherpaOnnxDecodeOnlineStream(impl_->recognizer, impl_->stream);
        }

        std::string text;
        const SherpaOnnxOnlineRecognizerResult* res =
            SherpaOnnxGetOnlineStreamResult(impl_->recognizer, impl_->stream);
        if (res) {
            if (res->text) text = res->text;
            SherpaOnnxDestroyOnlineRecognizerResult(res);
        }

        const bool endpoint = SherpaOnnxOnlineStreamIsEndpoint(
                                  impl_->recognizer, impl_->stream) != 0;

        // An endpoint on empty text is just silence: reset and keep the media
        // clock moving so the next utterance is stamped where it really starts.
        if (endpoint && text.empty()) {
            SherpaOnnxOnlineStreamReset(impl_->recognizer, impl_->stream);
            utterance_start_sample_ = global_sample_count_;
            last_emitted_text_.clear();
            continue;
        }

        const bool changed = text != last_emitted_text_;
        if (!text.empty() && (changed || endpoint)) {
            TranscriptSegment seg;
            seg.text = text;
            seg.t0_ms = (utterance_start_sample_ * 1000) / SAMPLE_RATE;
            seg.t1_ms = (global_sample_count_ * 1000) / SAMPLE_RATE;
            seg.is_partial = !endpoint;
            seg.latency_ms = arrived.time_since_epoch().count() == 0
                ? -1
                : std::chrono::duration_cast<std::chrono::milliseconds>(
                      clock::now() - arrived).count();

            if (endpoint) {
                float audio_sec =
                    static_cast<float>(global_sample_count_ - utterance_start_sample_) / SAMPLE_RATE;
                char buf[128];
                std::snprintf(buf, sizeof(buf), "Nemotron final: %.1fs: ", audio_sec);
                LOG_INFO(std::string(buf) + seg.text);
            }

            {
                std::lock_guard<std::mutex> lk(result_mutex_);
                result_queue_.push_back(std::move(seg));
            }
            last_emitted_text_ = text;
        }

        if (endpoint) {
            SherpaOnnxOnlineStreamReset(impl_->recognizer, impl_->stream);
            utterance_start_sample_ = global_sample_count_;
            last_emitted_text_.clear();
        }
    }

    LOG_INFO("Nemotron decode thread stopped");
}

// ---- Public interface (called from the pipeline thread) ----

bool NemotronTranscriber::load_model(const std::string& /*path*/) {
    if (loaded_.load()) return true;
    if (model_dir_.empty()) {
        LOG_WARN("Nemotron model directory not set");
        return false;
    }
    if (!create_recognizer()) return false;

    loaded_ = true;
    running_ = true;
    decode_thread_ = std::thread([this]() { decode_thread_func(); });
    return true;
}

void NemotronTranscriber::set_language(const std::string& lang) {
    {
        std::lock_guard<std::mutex> lk(lang_mutex_);
        if (language_ == lang) return;
        language_ = lang;
    }
    lang_dirty_ = true;
}

void NemotronTranscriber::feed_audio(const float* samples, size_t count) {
    if (!loaded_.load() || count == 0) return;
    {
        std::lock_guard<std::mutex> lk(audio_mutex_);
        // Stamp the first sample of each batch: once set, later samples join a
        // batch whose wait is already being timed from its oldest member.
        if (pending_since_.time_since_epoch().count() == 0) {
            pending_since_ = clock::now();
        }
        audio_pending_.insert(audio_pending_.end(), samples, samples + count);
    }
    audio_cv_.notify_one();
}

std::vector<TranscriptSegment> NemotronTranscriber::process() {
    if (!loaded_.load()) return {};
    std::vector<TranscriptSegment> results;
    std::lock_guard<std::mutex> lk(result_mutex_);
    if (!result_queue_.empty()) {
        results = std::move(result_queue_);
        result_queue_.clear();
    }
    return results;
}

} // namespace ais
