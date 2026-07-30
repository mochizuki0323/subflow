#include "audio/pipewire/pw_node_enumerator.h"
#include "audio/audio_source.h"
#include "core/logger.h"

#include <spa/utils/dict.h>
#include <cstdlib>
#include <cstring>

namespace ais {

static const struct pw_registry_events registry_events = {
    .version = PW_VERSION_REGISTRY_EVENTS,
    .global = PwNodeEnumerator::on_registry_global,
    .global_remove = PwNodeEnumerator::on_registry_global_remove,
};

PwNodeEnumerator::PwNodeEnumerator() = default;

PwNodeEnumerator::~PwNodeEnumerator() {
    stop();
}

void PwNodeEnumerator::start(struct pw_core* core) {
    registry_ = pw_core_get_registry(core, PW_VERSION_REGISTRY, 0);
    spa_zero(registry_listener_);
    pw_registry_add_listener(registry_, &registry_listener_, &registry_events, this);
    LOG_INFO("PipeWire node enumerator started");
}

void PwNodeEnumerator::stop() {
    if (registry_) {
        spa_hook_remove(&registry_listener_);
        pw_proxy_destroy(reinterpret_cast<struct pw_proxy*>(registry_));
        registry_ = nullptr;
    }
}

std::vector<AudioSourceInfo> PwNodeEnumerator::get_sources() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<AudioSourceInfo> result;
    for (const auto& [id, node] : nodes_) {
        result.push_back({id, node.name, node.description, node.media_class});
    }
    return result;
}

std::string PwNodeEnumerator::get_media_class(uint32_t id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = nodes_.find(id);
    if (it != nodes_.end()) return it->second.media_class;
    return "";
}

std::vector<PwPortInfo> PwNodeEnumerator::get_ports(uint32_t node_id, bool is_output) const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<PwPortInfo> result;
    for (const auto& [id, port] : ports_) {
        if (port.node_id == node_id && port.is_output == is_output) result.push_back(port);
    }
    return result;
}

void PwNodeEnumerator::on_registry_global(void* data, uint32_t id, uint32_t /*permissions*/,
                                           const char* type, uint32_t /*version*/,
                                           const struct spa_dict* props) {
    auto* self = static_cast<PwNodeEnumerator*>(data);
    if (!props) return;

    if (std::strcmp(type, PW_TYPE_INTERFACE_Node) == 0) {
        self->add_node(id, props);
    } else if (std::strcmp(type, PW_TYPE_INTERFACE_Port) == 0) {
        self->add_port(id, props);
    }
}

void PwNodeEnumerator::add_node(uint32_t id, const struct spa_dict* props) {
    const char* media_class = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
    if (!media_class)
        return;

    // We want application audio output streams and audio sinks
    bool is_playback = (std::strstr(media_class, "Stream/Output/Audio") != nullptr);
    bool is_sink = (std::strstr(media_class, "Audio/Sink") != nullptr);

    if (!is_playback && !is_sink)
        return;

    const char* name = spa_dict_lookup(props, PW_KEY_APP_NAME);
    if (!name) name = spa_dict_lookup(props, PW_KEY_NODE_NAME);
    if (!name) name = "Unknown";

    const char* desc = spa_dict_lookup(props, PW_KEY_NODE_DESCRIPTION);
    if (!desc) desc = spa_dict_lookup(props, PW_KEY_MEDIA_NAME);
    if (!desc) desc = name;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        nodes_[id] = {id, name, desc, media_class};
    }

    LOG_INFO("Found audio node: [" + std::to_string(id) + "] " + name + " (" + media_class + ")");

    if (change_cb_) change_cb_();
}

void PwNodeEnumerator::add_port(uint32_t id, const struct spa_dict* props) {
    const char* direction = spa_dict_lookup(props, PW_KEY_PORT_DIRECTION);
    const char* node_id = spa_dict_lookup(props, PW_KEY_NODE_ID);
    if (!direction || !node_id) return;

    const char* channel = spa_dict_lookup(props, PW_KEY_AUDIO_CHANNEL);

    PwPortInfo port;
    port.id = id;
    port.node_id = static_cast<uint32_t>(std::strtoul(node_id, nullptr, 10));
    port.is_output = (std::strcmp(direction, "out") == 0);
    port.channel = channel ? channel : "";

    {
        std::lock_guard<std::mutex> lock(mutex_);
        ports_[id] = port;
    }

    // Fired outside the lock: the handler calls back into get_ports().
    if (port_cb_) port_cb_(port);
}

void PwNodeEnumerator::on_registry_global_remove(void* data, uint32_t id) {
    auto* self = static_cast<PwNodeEnumerator*>(data);
    bool was_node = false;
    {
        std::lock_guard<std::mutex> lock(self->mutex_);
        was_node = self->nodes_.erase(id) > 0;
        self->ports_.erase(id);
    }
    if (was_node && self->change_cb_) self->change_cb_();
}

} // namespace ais
