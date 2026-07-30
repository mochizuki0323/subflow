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

/** A single audio port on a PipeWire node. */
struct PwPortInfo {
    uint32_t id = 0;
    uint32_t node_id = 0;
    bool is_output = false;
    /** `audio.channel`, e.g. "FL"/"FR"/"MONO". Empty when the port does not declare one. */
    std::string channel;
};

class PwNodeEnumerator {
public:
    PwNodeEnumerator();
    ~PwNodeEnumerator();

    void start(struct pw_core* core);
    void stop();

    std::vector<AudioSourceInfo> get_sources() const;

    // Returns the media_class for a node ID, or empty string if not found.
    std::string get_media_class(uint32_t id) const;

    /** Audio ports belonging to `node_id` in the requested direction. */
    std::vector<PwPortInfo> get_ports(uint32_t node_id, bool is_output) const;

    using ChangeCallback = std::function<void()>;
    void on_change(ChangeCallback cb) { change_cb_ = std::move(cb); }

    using PortCallback = std::function<void(const PwPortInfo&)>;
    /** Fired on the PipeWire loop thread whenever a port appears. */
    void on_port_added(PortCallback cb) { port_cb_ = std::move(cb); }

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

    void add_node(uint32_t id, const struct spa_dict* props);
    void add_port(uint32_t id, const struct spa_dict* props);

    struct pw_registry* registry_ = nullptr;
    struct spa_hook registry_listener_{};

    mutable std::mutex mutex_;
    std::map<uint32_t, NodeInfo> nodes_;
    std::map<uint32_t, PwPortInfo> ports_;
    ChangeCallback change_cb_;
    PortCallback port_cb_;
};

} // namespace ais
