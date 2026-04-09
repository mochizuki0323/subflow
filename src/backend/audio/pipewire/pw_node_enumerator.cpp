#include "audio/pipewire/pw_node_enumerator.h"
#include "audio/audio_source.h"
#include "core/logger.h"

#include <spa/utils/dict.h>
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

void PwNodeEnumerator::on_registry_global(void* data, uint32_t id, uint32_t /*permissions*/,
                                           const char* type, uint32_t /*version*/,
                                           const struct spa_dict* props) {
    auto* self = static_cast<PwNodeEnumerator*>(data);

    if (std::strcmp(type, PW_TYPE_INTERFACE_Node) != 0 || !props)
        return;

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
        std::lock_guard<std::mutex> lock(self->mutex_);
        self->nodes_[id] = {id, name, desc, media_class};
    }

    LOG_INFO("Found audio node: [" + std::to_string(id) + "] " + name + " (" + media_class + ")");

    if (self->change_cb_) self->change_cb_();
}

void PwNodeEnumerator::on_registry_global_remove(void* data, uint32_t id) {
    auto* self = static_cast<PwNodeEnumerator*>(data);
    {
        std::lock_guard<std::mutex> lock(self->mutex_);
        self->nodes_.erase(id);
    }
    if (self->change_cb_) self->change_cb_();
}

} // namespace ais
