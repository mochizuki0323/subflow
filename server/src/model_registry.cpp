#include "model_registry.h"
#include "log.h"

#include <filesystem>
#include <utility>

namespace ais {

namespace fs = std::filesystem;

ModelRegistry::ModelRegistry(BaseConfig base) : base_(std::move(base)) {}

ModelRegistry::~ModelRegistry() { stop(); }

std::string ModelRegistry::detect_type(const std::string& dir) {
    auto has = [&](const char* f) { return fs::exists(fs::path(dir) / f); };
    if (!has("tokens.txt")) return "";  // every Parakeet model ships tokens.txt
    if (has("model.int8.onnx")) return "nemo_ctc";
    if (has("encoder.int8.onnx") && has("decoder.int8.onnx") && has("joiner.int8.onnx"))
        return "nemo_transducer";
    return "";
}

bool ModelRegistry::add_model(const std::string& id, const std::string& dir, const std::string& type) {
    std::string t = type;
    if (t.empty()) {
        // No explicit type (the single --model-dir shortcut) — detect from files.
        t = detect_type(dir);
        if (t.empty()) {
            LOG_ERROR("ModelRegistry: no recognizable model files in " + dir + " (id=" + id + ")");
            return false;
        }
    } else if (t != "nemo_ctc" && t != "nemo_transducer") {
        LOG_ERROR("ModelRegistry: invalid type '" + t + "' for model '" + id + "' (use nemo_ctc | nemo_transducer)");
        return false;
    } else {
        std::error_code ec;
        if (!fs::is_directory(dir, ec)) {
            LOG_ERROR("ModelRegistry: model dir not found: " + dir + " (id=" + id + ")");
            return false;
        }
    }
    std::lock_guard<std::mutex> lk(mtx_);
    if (slots_.count(id)) {
        LOG_WARN("ModelRegistry: duplicate model id '" + id + "' ignored");
        return false;
    }
    auto slot = std::make_shared<Slot>();
    slot->id = id;
    slot->dir = dir;
    slot->type = t;
    slots_[id] = std::move(slot);
    LOG_INFO("ModelRegistry: registered '" + id + "' (type=" + t + ", dir=" + dir + ")");
    return true;
}

std::vector<ModelRegistry::ModelInfo> ModelRegistry::list() const {
    std::lock_guard<std::mutex> lk(mtx_);
    std::vector<ModelInfo> out;
    out.reserve(slots_.size());
    for (const auto& [id, slot] : slots_) out.push_back({slot->id, slot->type});
    return out;
}

bool ModelRegistry::has(const std::string& id) const {
    std::lock_guard<std::mutex> lk(mtx_);
    return slots_.count(id) > 0;
}

std::string ModelRegistry::default_id() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return slots_.size() == 1 ? slots_.begin()->first : std::string{};
}

size_t ModelRegistry::size() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return slots_.size();
}

void ModelRegistry::start() {
    if (running_.exchange(true)) return;
    loader_ = std::thread([this] { loader_loop(); });
}

void ModelRegistry::stop() {
    if (running_.exchange(false)) {
        cv_.notify_all();
        if (loader_.joinable()) loader_.join();
    }
    // Stop schedulers explicitly (their dtors would too, but do it deterministically).
    std::lock_guard<std::mutex> lk(mtx_);
    for (auto& [id, slot] : slots_) {
        if (slot->scheduler) slot->scheduler->stop();
    }
}

void ModelRegistry::get_or_load(const std::string& id, ReadyCallback cb) {
    ParakeetModel* m = nullptr;
    DecodeScheduler* s = nullptr;
    bool fire_loaded = false;
    bool fire_fail = false;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        auto it = slots_.find(id);
        if (it == slots_.end()) {
            fire_fail = true;  // unknown model id
        } else {
            auto& slot = it->second;
            switch (slot->state) {
                case State::kLoaded:
                    m = slot->model.get();
                    s = slot->scheduler.get();
                    fire_loaded = true;
                    break;
                case State::kFailed:
                    fire_fail = true;
                    break;
                case State::kNotLoaded:
                    slot->state = State::kLoading;
                    slot->waiters.push_back(std::move(cb));
                    load_queue_.push_back(id);
                    cv_.notify_one();
                    return;
                case State::kLoading:
                    slot->waiters.push_back(std::move(cb));
                    return;
            }
        }
    }
    if (fire_loaded) cb(m, s);
    else if (fire_fail) cb(nullptr, nullptr);
}

void ModelRegistry::loader_loop() {
    while (true) {
        std::string id;
        {
            std::unique_lock<std::mutex> lk(mtx_);
            cv_.wait(lk, [this] { return !running_.load() || !load_queue_.empty(); });
            if (!running_.load() && load_queue_.empty()) return;
            id = std::move(load_queue_.front());
            load_queue_.pop_front();
        }

        std::shared_ptr<Slot> slot;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            auto it = slots_.find(id);
            if (it != slots_.end()) slot = it->second;
        }
        if (!slot) continue;

        // Load OUTSIDE the lock — this is the slow part.
        LOG_INFO("ModelRegistry: loading model '" + id + "'...");
        ParakeetModelConfig cfg;
        cfg.model_dir = slot->dir;
        cfg.model_type = slot->type;
        cfg.num_threads = base_.num_threads;
        cfg.provider = base_.provider;
        auto model = std::make_unique<ParakeetModel>(cfg);
        const bool ok = model->load();
        std::unique_ptr<DecodeScheduler> scheduler;
        if (ok) {
            scheduler = std::make_unique<DecodeScheduler>(*model, base_.max_batch);
            scheduler->start();
        }

        // Commit result and collect waiters under the lock.
        std::vector<ReadyCallback> waiters;
        ParakeetModel* mp = nullptr;
        DecodeScheduler* sp = nullptr;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (ok) {
                slot->model = std::move(model);
                slot->scheduler = std::move(scheduler);
                slot->state = State::kLoaded;
                mp = slot->model.get();
                sp = slot->scheduler.get();
            } else {
                slot->state = State::kFailed;
            }
            waiters.swap(slot->waiters);
        }
        if (ok) LOG_INFO("ModelRegistry: model '" + id + "' ready");
        else LOG_ERROR("ModelRegistry: model '" + id + "' failed to load");

        for (auto& w : waiters) w(mp, sp);
    }
}

uint64_t ModelRegistry::total_decoded() const {
    std::lock_guard<std::mutex> lk(mtx_);
    uint64_t t = 0;
    for (const auto& [id, slot] : slots_) if (slot->scheduler) t += slot->scheduler->total_decoded();
    return t;
}

uint64_t ModelRegistry::total_batches() const {
    std::lock_guard<std::mutex> lk(mtx_);
    uint64_t t = 0;
    for (const auto& [id, slot] : slots_) if (slot->scheduler) t += slot->scheduler->total_batches();
    return t;
}

size_t ModelRegistry::pending() const {
    std::lock_guard<std::mutex> lk(mtx_);
    size_t t = 0;
    for (const auto& [id, slot] : slots_) if (slot->scheduler) t += slot->scheduler->pending();
    return t;
}

size_t ModelRegistry::loaded_count() const {
    std::lock_guard<std::mutex> lk(mtx_);
    size_t n = 0;
    for (const auto& [id, slot] : slots_) if (slot->state == State::kLoaded) ++n;
    return n;
}

} // namespace ais
