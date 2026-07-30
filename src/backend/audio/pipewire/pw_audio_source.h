#pragma once
#include "audio/audio_source.h"
#include "audio/audio_buffer.h"
#include "audio/pipewire/pw_node_enumerator.h"

#include <pipewire/pipewire.h>
#include <atomic>
#include <set>
#include <utility>
#include <vector>

namespace ais {

class PwAudioSource : public IAudioSource {
public:
    PwAudioSource();
    ~PwAudioSource() override;

    std::vector<AudioSourceInfo> list_sources() override;
    bool start_capture(uint32_t source_id) override;
    void stop_capture() override;
    AudioRingBuffer& get_buffer() override { return buffer_; }
    void on_source_list_changed(SourceChangeCallback cb) override;

    // PipeWire callbacks (must be accessible from C callback structs)
    static void on_process(void* userdata);
    static void on_stream_param_changed(void* userdata, uint32_t id,
                                         const struct spa_pod* param);
    static void on_stream_state_changed(void* userdata, enum pw_stream_state old,
                                        enum pw_stream_state state, const char* error);

private:
    // All of these must be called with the thread loop locked.
    void create_monitor_stream(uint32_t sink_id);
    void create_app_stream(uint32_t app_node_id);
    void connect_stream(struct pw_properties* props, bool autoconnect, uint32_t channels);
    void destroy_stream();
    void link_target_ports();
    bool create_link(const PwPortInfo& output, const PwPortInfo& input);
    void destroy_links();

    struct pw_thread_loop* loop_ = nullptr;
    struct pw_context* context_ = nullptr;
    struct pw_core* core_ = nullptr;
    struct pw_stream* stream_ = nullptr;
    struct spa_hook stream_listener_{};

    PwNodeEnumerator enumerator_;
    AudioRingBuffer buffer_;
    SourceChangeCallback source_change_cb_;

    // Per-application capture: we link the app's output ports to our own input
    // ports by hand, so both node ids and the links have to be tracked.
    uint32_t target_node_id_ = SPA_ID_INVALID;
    uint32_t capture_node_id_ = SPA_ID_INVALID;
    std::vector<struct pw_proxy*> links_;
    std::set<std::pair<uint32_t, uint32_t>> linked_pairs_;

    // Resampling state
    std::atomic<uint32_t> source_rate_{48000};
    std::atomic<uint32_t> source_channels_{1};
    std::atomic<bool> capturing_{false};
};

} // namespace ais
