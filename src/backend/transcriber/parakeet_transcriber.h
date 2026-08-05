#pragma once
#include "transcriber/transcriber.h"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>

namespace ais {

// Tunable Silero VAD / simulated-streaming parameters. Durations in seconds.
struct ParakeetVadParams {
    float threshold = 0.3f;          // speech probability cutoff (0..1)
    float min_silence = 0.5f;        // silence before a segment closes
    float min_speech = 0.25f;        // shortest accepted speech segment
    float max_speech = 15.0f;        // force-cut very long speech
    float partial_interval = 0.2f;   // re-decode period for interim results
};

// Simulated streaming with separate decode thread:
//   Pipeline thread: runs Silero VAD, accumulates speech, queues decode requests
//   Decode thread:   runs offline ASR, produces TranscriptSegment results
//
// During active speech, a snapshot of the accumulated buffer is taken every
// PARTIAL_INTERVAL and decoded as a partial (interim) result. When VAD closes
// the segment, the full segment is decoded as a final result.
class ParakeetTranscriber : public ITranscriber {
public:
    using VadParams = ParakeetVadParams;

    // num_threads is deliberately not part of VadParams: those are replayed at
    // runtime through set_vad_params, and ORT's thread count is fixed when the
    // recogniser is built. Putting it there would promise a live change the
    // recogniser cannot make.
    explicit ParakeetTranscriber(std::string model_dir,
                                 std::string model_type,
                                 std::string vad_model,
                                 VadParams params = {},
                                 int num_threads = 4);
    ~ParakeetTranscriber() override;

    // Apply new VAD parameters at runtime (no restart). Thread-safe; the VAD is
    // rebuilt lazily on the pipeline thread inside process().
    void set_vad_params(const VadParams& params);

    bool load_model(const std::string& path) override;
    void set_language(const std::string& lang) override;
    void set_translate(bool) override {}
    void feed_audio(const float* samples, size_t count) override;
    std::vector<TranscriptSegment> process() override;
    bool is_model_loaded() const override { return loaded_.load(); }

private:
    bool create_recognizer();
    bool create_vad();
    void rebuild_vad();
    std::string resolve_file(const std::string& name) const;
    std::string decode_buffer(const float* samples, int32_t n);
    void decode_thread_func();

    std::string model_dir_;
    std::string model_type_;
    std::string vad_model_path_;
    int num_threads_ = 4;
    std::string language_ = "auto";

    struct Impl;
    Impl* impl_ = nullptr;
    std::atomic<bool> loaded_{false};

    // --- Pipeline thread state (single-threaded, no lock needed) ---

    // Raw audio from engine, not yet consumed by VAD
    std::mutex audio_mutex_;
    std::vector<float> audio_pending_;

    // Leftover samples from previous process() that didn't fill a VAD window
    std::vector<float> vad_remainder_;

    // Speech buffer accumulating samples while VAD is in speech state
    std::vector<float> speech_buf_;
    int64_t segment_start_sample_ = 0;
    int64_t global_sample_count_ = 0;

    using clock = std::chrono::steady_clock;
    clock::time_point last_partial_time_{};

    // --- Decode thread communication (single lock) ---

    struct DecodeRequest {
        std::vector<float> samples;
        int64_t t0_sample = 0;
        int64_t t1_sample = 0;
        bool is_final = false;
        // When the pipeline thread handed this over. Measuring from here — rather
        // than from the media clock, which only advances while audio is flowing and
        // never resets — gives a latency that stays true across pauses.
        clock::time_point queued_at{};
    };

    // Single mutex protecting all shared decode state
    std::mutex queue_mutex_;
    std::condition_variable queue_cv_;
    std::queue<DecodeRequest> final_queue_;
    DecodeRequest partial_snapshot_;
    bool partial_ready_ = false;

    // Results produced by decode thread, consumed by process()
    std::mutex result_mutex_;
    std::vector<TranscriptSegment> result_queue_;

    std::thread decode_thread_;
    std::atomic<bool> running_{false};

    static constexpr int SAMPLE_RATE = 16000;
    static constexpr int VAD_WINDOW = 512;

    // Active VAD parameters (pipeline-thread only once applied)
    VadParams params_;

    // Runtime update channel: set_vad_params() stashes into pending_params_ and
    // raises vad_dirty_; process() applies them + rebuilds the VAD on the
    // pipeline thread so impl_->vad is never touched concurrently.
    std::mutex vad_params_mutex_;
    VadParams pending_params_;
    std::atomic<bool> vad_dirty_{false};
};

} // namespace ais
