#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include <pipewire/pipewire.h>

namespace ais {

struct AudioSourceInfo;

class PwNodeEnumerator {
public:
    PwNodeEnumerator();
    ~PwNodeEnumerator();

    void start(struct pw_core* core);
    void stop();

    std::vector<AudioSourceInfo> get_sources() const;

    // Returns the media_class for a node ID, or empty string if not found.
    std::string get_media_class(uint32_t id) const;

    using ChangeCallback = std::function<void()>;
    void on_change(ChangeCallback cb) { change_cb_ = std::move(cb); }

    // PipeWire callbacks (must be accessible from C callback structs)
    static void on_registry_global(void* data, uint32_t id, uint32_t permissions,
                                   const char* type, uint32_t version,
                                   const struct spa_dict* props);
    static void on_registry_global_remove(void* data, uint32_t id);

private:
    struct NodeInfo {
        uint32_t id;
        std::string name;
        std::string description;
        std::string media_class;
    };

    struct pw_registry* registry_ = nullptr;
    struct spa_hook registry_listener_{};

    mutable std::mutex mutex_;
    std::map<uint32_t, NodeInfo> nodes_;
    ChangeCallback change_cb_;
};

} // namespace ais
