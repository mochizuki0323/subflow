#pragma once
// Shared decode scheduler. A single dispatcher thread pulls pending decode jobs
// from all sessions, batches them into one ParakeetModel::decode_batch() call,
// and routes each result back to the submitting session. Because only this one
// thread ever drives the recognizer, no decode-time locking is needed and the
// thread count stays O(1) regardless of how many clients are connected.
//
// Scheduling policy: final segments are always queued and decoded (FIFO, highest
// priority). Partial (interim) segments are coalesced per session — only the
// latest pending partial per session is kept — and fill any remaining batch
// capacity after finals, so under load partials degrade gracefully instead of
// piling up.
#include "parakeet_model.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

namespace ais {

class DecodeScheduler {
public:
    // Invoked on the scheduler thread once a job has been decoded (non-empty text only).
    using ResultSink = std::function<void(const std::string& text, int64_t t0_ms,
                                          int64_t t1_ms, bool is_final)>;

    DecodeScheduler(ParakeetModel& model, int max_batch = 8);
    ~DecodeScheduler();

    void start();
    void stop();

    void submit_final(uint64_t session_id, std::vector<float> samples,
                      int64_t t0_ms, int64_t t1_ms, ResultSink sink);
    // Replaces any pending partial for the session (coalesced).
    void submit_partial(uint64_t session_id, std::vector<float> samples,
                        int64_t t0_ms, int64_t t1_ms, ResultSink sink);
    // Drop a disconnected session's pending partial (queued finals self-discard
    // via their weak sink).
    void drop_session(uint64_t session_id);

    // ── Metrics ───────────────────────────────────────────────────────────────
    uint64_t total_decoded() const { return total_decoded_.load(); }
    uint64_t total_batches() const { return total_batches_.load(); }
    size_t pending() const;

private:
    struct Job {
        uint64_t session_id = 0;
        std::vector<float> samples;
        int64_t t0_ms = 0;
        int64_t t1_ms = 0;
        bool is_final = false;
        ResultSink sink;
    };

    void run();

    ParakeetModel& model_;
    const int max_batch_;

    std::thread thread_;
    std::atomic<bool> running_{false};

    mutable std::mutex mtx_;
    std::condition_variable cv_;
    std::deque<Job> finals_;
    std::map<uint64_t, Job> partials_;  // session_id -> latest pending partial

    std::atomic<uint64_t> total_decoded_{0};
    std::atomic<uint64_t> total_batches_{0};
};

} // namespace ais
