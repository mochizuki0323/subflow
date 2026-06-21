#include "decode_scheduler.h"
#include "log.h"

#include <chrono>
#include <utility>

namespace ais {

DecodeScheduler::DecodeScheduler(ParakeetModel& model, int max_batch)
    : model_(model), max_batch_(max_batch < 1 ? 1 : max_batch) {}

DecodeScheduler::~DecodeScheduler() { stop(); }

void DecodeScheduler::start() {
    if (running_.exchange(true)) return;
    thread_ = std::thread([this] { run(); });
}

void DecodeScheduler::stop() {
    if (!running_.exchange(false)) {
        if (thread_.joinable()) thread_.join();
        return;
    }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
}

void DecodeScheduler::submit_final(uint64_t session_id, std::vector<float> samples,
                                   int64_t t0_ms, int64_t t1_ms, ResultSink sink) {
    {
        std::lock_guard<std::mutex> lk(mtx_);
        finals_.push_back(Job{session_id, std::move(samples), t0_ms, t1_ms, true, std::move(sink)});
    }
    cv_.notify_one();
}

void DecodeScheduler::submit_partial(uint64_t session_id, std::vector<float> samples,
                                     int64_t t0_ms, int64_t t1_ms, ResultSink sink) {
    {
        std::lock_guard<std::mutex> lk(mtx_);
        partials_[session_id] =
            Job{session_id, std::move(samples), t0_ms, t1_ms, false, std::move(sink)};
    }
    cv_.notify_one();
}

void DecodeScheduler::drop_session(uint64_t session_id) {
    std::lock_guard<std::mutex> lk(mtx_);
    partials_.erase(session_id);
}

size_t DecodeScheduler::pending() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return finals_.size() + partials_.size();
}

void DecodeScheduler::run() {
    LOG_INFO("DecodeScheduler started (max_batch=" + std::to_string(max_batch_) + ")");

    while (running_.load()) {
        std::vector<Job> batch;
        {
            std::unique_lock<std::mutex> lk(mtx_);
            cv_.wait_for(lk, std::chrono::milliseconds(20), [this] {
                return !running_.load() || !finals_.empty() || !partials_.empty();
            });
            if (!running_.load()) break;

            // Finals first (highest priority).
            while (!finals_.empty() && static_cast<int>(batch.size()) < max_batch_) {
                batch.push_back(std::move(finals_.front()));
                finals_.pop_front();
            }
            // Then one coalesced partial per session, filling remaining capacity.
            for (auto it = partials_.begin();
                 it != partials_.end() && static_cast<int>(batch.size()) < max_batch_;) {
                batch.push_back(std::move(it->second));
                it = partials_.erase(it);
            }
        }

        if (batch.empty()) continue;

        std::vector<DecodeInput> inputs;
        inputs.reserve(batch.size());
        for (const auto& job : batch) {
            inputs.push_back(DecodeInput{job.samples.data(), static_cast<int32_t>(job.samples.size())});
        }

        std::vector<std::string> texts = model_.decode_batch(inputs);

        total_batches_.fetch_add(1, std::memory_order_relaxed);
        total_decoded_.fetch_add(batch.size(), std::memory_order_relaxed);

        for (size_t i = 0; i < batch.size(); ++i) {
            if (i < texts.size() && !texts[i].empty() && batch[i].sink) {
                batch[i].sink(texts[i], batch[i].t0_ms, batch[i].t1_ms, batch[i].is_final);
            }
        }
    }

    LOG_INFO("DecodeScheduler stopped");
}

} // namespace ais
