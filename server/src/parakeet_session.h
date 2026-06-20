#pragma once
// Per-connection ASR session. Owns its own Silero VAD and runs the simulated-
// streaming state machine (ported from ParakeetTranscriber::process) on a
// dedicated lightweight worker thread: it detects speech segments and submits
// decode jobs to the shared DecodeScheduler. Decoding itself happens on the
// scheduler's single thread against the one shared recognizer, so per-session
// cost is just the (tiny) VAD plus audio buffers.
#include "decode_scheduler.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct SherpaOnnxVoiceActivityDetector;  // opaque (sherpa-onnx C API)

namespace ais {

struct ServerVadParams {
    float threshold = 0.3f;
    float min_silence = 0.5f;
    float min_speech = 0.25f;
    float max_speech = 15.0f;
    float partial_interval = 0.2f;
};

class ParakeetSession : public std::enable_shared_from_this<ParakeetSession> {
public:
    // Delivered on the scheduler thread; implementations must be thread-safe
    // (the server marshals onto the uWS loop via Loop::defer).
    using TranscriptCallback = std::function<void(const std::string& text, int64_t t0_ms,
                                                  int64_t t1_ms, bool is_final)>;

    ParakeetSession(uint64_t id, DecodeScheduler& scheduler,
                    std::string vad_model_path, ServerVadParams vad_params,
                    TranscriptCallback on_transcript);
    ~ParakeetSession();

    bool start();   // create VAD + spawn worker thread
    void stop();    // stop worker, drop pending partial from scheduler

    // Thread-safe; called from the uWS loop thread on each inbound audio frame.
    void feed_audio(const float* samples, size_t count);

    uint64_t id() const { return id_; }

private:
    bool create_vad();
    void worker_loop();
    void process_audio(std::vector<float>& incoming);
    DecodeScheduler::ResultSink make_sink();

    uint64_t id_;
    DecodeScheduler& scheduler_;
    std::string vad_model_path_;
    ServerVadParams params_;
    TranscriptCallback on_transcript_;

    const SherpaOnnxVoiceActivityDetector* vad_ = nullptr;

    std::thread worker_;
    std::atomic<bool> running_{false};

    std::mutex audio_mutex_;
    std::condition_variable audio_cv_;
    std::vector<float> audio_pending_;

    // worker-thread-only VAD state
    std::vector<float> vad_remainder_;
    std::vector<float> speech_buf_;
    int64_t segment_start_sample_ = 0;
    int64_t global_sample_count_ = 0;
    std::chrono::steady_clock::time_point last_partial_time_;

    static constexpr int kSampleRate = 16000;
    static constexpr int kVadWindow = 512;
};

} // namespace ais
