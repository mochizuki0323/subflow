#pragma once
// Registry of Parakeet models the server can serve. Models are declared up
// front in a JSON manifest (metadata only) but loaded lazily: each model's
// weights enter RAM the first time a client selects it, and stay cached
// afterwards. Crucially, a given model is loaded EXACTLY ONCE — every connection
// that selects the same model id shares the one ParakeetModel + DecodeScheduler,
// so RAM is O(distinct models), not O(connections).
//
// Loading happens on a dedicated loader thread so a (multi-second) model load
// never blocks the uWS event loop or other connections. Concurrent requests for
// the same not-yet-loaded model are coalesced into a single load.
#include "parakeet_model.h"
#include "decode_scheduler.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ais {

class ModelRegistry {
public:
    struct ModelInfo {
        std::string id;
        std::string type;  // "nemo_ctc" | "nemo_transducer"
    };

    // Per-model settings that don't vary between models on this server.
    struct BaseConfig {
        int num_threads = 4;
        std::string provider = "cpu";
        int max_batch = 8;
    };

    explicit ModelRegistry(BaseConfig base);
    ~ModelRegistry();

    ModelRegistry(const ModelRegistry&) = delete;
    ModelRegistry& operator=(const ModelRegistry&) = delete;

    // Register one model's metadata WITHOUT loading it. type must be
    // "nemo_ctc" | "nemo_transducer"; when empty it is auto-detected from the
    // directory (used by the single --model-dir shortcut). Returns false on bad
    // dir / invalid type / dup id. Models are declared explicitly (by the server
    // config file or --model-dir) — there is no directory scan.
    bool add_model(const std::string& id, const std::string& dir, const std::string& type = "");

    std::vector<ModelInfo> list() const;
    bool has(const std::string& id) const;
    std::string default_id() const;  // the id when exactly one model exists, else ""
    size_t size() const;

    void start();  // start the loader thread
    void stop();   // stop loader thread + all schedulers

    // Resolve a model, loading it if necessary. cb receives non-null
    // (model, scheduler) on success and (nullptr, nullptr) on unknown id or load
    // failure. cb runs on the loader thread, or inline on the caller's thread when
    // the model is already loaded — so cb must be thread-safe.
    using ReadyCallback = std::function<void(ParakeetModel*, DecodeScheduler*)>;
    void get_or_load(const std::string& id, ReadyCallback cb);

    // Aggregate metrics across loaded models.
    uint64_t total_decoded() const;
    uint64_t total_batches() const;
    size_t pending() const;
    size_t loaded_count() const;

    // "" when dir holds no recognizable model files.
    static std::string detect_type(const std::string& dir);

private:
    enum class State { kNotLoaded, kLoading, kLoaded, kFailed };

    struct Slot {
        std::string id;
        std::string dir;
        std::string type;
        State state = State::kNotLoaded;
        std::unique_ptr<ParakeetModel> model;       // declared before scheduler:
        std::unique_ptr<DecodeScheduler> scheduler; // scheduler tears down first
        std::vector<ReadyCallback> waiters;         // pending while kLoading
    };

    void loader_loop();

    BaseConfig base_;

    mutable std::mutex mtx_;
    std::map<std::string, std::shared_ptr<Slot>> slots_;  // ordered, pointer-stable

    std::condition_variable cv_;
    std::deque<std::string> load_queue_;
    std::thread loader_;
    std::atomic<bool> running_{false};
};

} // namespace ais
