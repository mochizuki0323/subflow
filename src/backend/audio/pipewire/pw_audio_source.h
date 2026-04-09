#pragma once
#include "audio/audio_source.h"
#include "audio/audio_buffer.h"
#include "audio/pipewire/pw_node_enumerator.h"

#include <pipewire/pipewire.h>
#include <atomic>

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

private:
    void create_stream(uint32_t target_id);
    void destroy_stream();

    struct pw_thread_loop* loop_ = nullptr;
    struct pw_context* context_ = nullptr;
    struct pw_core* core_ = nullptr;
    struct pw_stream* stream_ = nullptr;
    struct spa_hook stream_listener_{};

    PwNodeEnumerator enumerator_;
    AudioRingBuffer buffer_;
    SourceChangeCallback source_change_cb_;

    // Resampling state
    uint32_t source_rate_ = 48000;
    uint32_t source_channels_ = 2;
    std::atomic<bool> capturing_{false};
};

} // namespace ais
