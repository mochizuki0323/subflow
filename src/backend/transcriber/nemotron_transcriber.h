#pragma once
#include "transcriber/transcriber.h"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ais {

// Endpoint rules for the streaming recogniser, in seconds. The model decides
// where an utterance ends itself, so there is no VAD and nothing to re-decode.
struct NemotronEndpointParams {
    // sherpa ORs three endpoint rules, so the effective threshold is whichever
    // fires first. rule1 applies whether or not anything has been decoded yet;
    // rule2 only once there is text. Both defaults are sherpa's own, and rule1's
    // doubles as a floor the caller will not go below: silence here means
    // trailing *blanks*, so speech the model has not committed to a token yet
    // counts as silence, and a rule1 shorter than that emission delay would
    // reset the stream in the middle of the word it is still deciding.
    float min_trailing_silence = 2.4f;      // rule1: trailing silence, text or not
    float min_trailing_silence_after = 1.2f;// rule2: trailing silence once text exists
    float max_utterance = 20.0f;            // rule3: force-cut a very long utterance
    // ORT intra-op threads. Two by default: measured on this workload 4 threads
    // cost 0.54 CPU cores at RTF 0.077 while 2 cost 0.27 at RTF 0.089 — double
    // the CPU to shave a margin that is already 11x realtime. It matters more
    // here than for the offline path because a streaming encoder runs
    // continuously: silence costs the same as speech, so this is the machine's
    // idle draw whenever capture is on, not a per-utterance cost. Slower CPUs
    // may still want more, which is why it is exposed rather than fixed.
    int num_threads = 2;
};

// Cache-aware streaming ASR (NVIDIA Nemotron 3.5 / nemotron-speech-streaming)
// over sherpa-onnx's OnlineRecognizer.
//
// This is the counterpart to ParakeetTranscriber, not a replacement: Parakeet
// models are offline, so that class fakes streaming with Silero VAD plus
// periodic re-decodes. These models stream natively — audio goes in, text comes
// out incrementally, and the model reports its own endpoints — so there is no
// VAD to load, no snapshot to re-decode, and interim text is whatever the
// recogniser has committed to so far.
//
// One decode thread owns the stream outright. sherpa's OnlineStream is not safe
// against AcceptWaveform racing Decode, and decoding on the pipeline thread
// would stall audio capture on a slow machine and show up as dropped_ms.
class NemotronTranscriber : public ITranscriber {
public:
    using EndpointParams = NemotronEndpointParams;

    explicit NemotronTranscriber(std::string model_dir, EndpointParams params = {});
    ~NemotronTranscriber() override;

    bool load_model(const std::string& path) override;
    void set_language(const std::string& lang) override;
    void set_translate(bool) override {}
    void feed_audio(const float* samples, size_t count) override;
    std::vector<TranscriptSegment> process() override;
    bool is_model_loaded() const override { return loaded_.load(); }

private:
    bool create_recognizer();
    std::string resolve_file(const std::string& name) const;
    void decode_thread_func();
    void apply_language();

    std::string model_dir_;
    EndpointParams params_;

    struct Impl;
    Impl* impl_ = nullptr;
    std::atomic<bool> loaded_{false};

    using clock = std::chrono::steady_clock;

    // --- Pipeline thread -> decode thread ---
    std::mutex audio_mutex_;
    std::condition_variable audio_cv_;
    std::vector<float> audio_pending_;
    // When the oldest still-undecoded audio arrived, so latency covers the wait
    // as well as the decode. Cleared each time text is produced.
    clock::time_point pending_since_{};

    // Language is applied on the decode thread: the option belongs to the
    // stream, which only that thread may touch.
    std::mutex lang_mutex_;
    std::string language_ = "auto";
    std::string applied_language_;
    std::atomic<bool> lang_dirty_{true};

    // --- Decode thread -> process() ---
    std::mutex result_mutex_;
    std::vector<TranscriptSegment> result_queue_;

    std::thread decode_thread_;
    std::atomic<bool> running_{false};

    // Media clock, in samples fed. Only the decode thread touches these.
    int64_t global_sample_count_ = 0;
    int64_t utterance_start_sample_ = 0;
    std::string last_emitted_text_;

    static constexpr int SAMPLE_RATE = 16000;
    // FastConformer front-end: 128 mel bins, not the 80 the offline models use.
    static constexpr int FEATURE_DIM = 128;
};

} // namespace ais
