#include "audio/pipewire/pw_audio_source.h"
#include "core/logger.h"

#include <pipewire/link.h>
#include <spa/param/audio/format-utils.h>
#include <spa/param/props.h>
#include <spa/pod/builder.h>

#include <algorithm>

namespace ais {

static const struct pw_stream_events stream_events = {
    .version = PW_VERSION_STREAM_EVENTS,
    .state_changed = PwAudioSource::on_stream_state_changed,
    .param_changed = PwAudioSource::on_stream_param_changed,
    .process = PwAudioSource::on_process,
};

PwAudioSource::PwAudioSource() {
    pw_init(nullptr, nullptr);

    loop_ = pw_thread_loop_new("ai-subtitles-audio", nullptr);
    context_ = pw_context_new(pw_thread_loop_get_loop(loop_), nullptr, 0);

    pw_thread_loop_start(loop_);

    pw_thread_loop_lock(loop_);
    core_ = pw_context_connect(context_, nullptr, 0);
    if (core_) {
        // Ports show up asynchronously — ours after the stream node is created, the
        // application's whenever it (re)negotiates its format. Link whatever arrives.
        enumerator_.on_port_added([this](const PwPortInfo& port) {
            if (target_node_id_ == SPA_ID_INVALID) return;
            if (capture_node_id_ == SPA_ID_INVALID && stream_) {
                capture_node_id_ = pw_stream_get_node_id(stream_);
            }
            if (port.node_id == capture_node_id_ || port.node_id == target_node_id_) {
                link_target_ports();
            }
        });
        enumerator_.start(core_);
    }
    pw_thread_loop_unlock(loop_);

    if (!core_) {
        LOG_ERROR("Failed to connect to PipeWire");
    }
}

PwAudioSource::~PwAudioSource() {
    stop_capture();

    if (loop_) {
        pw_thread_loop_lock(loop_);
        enumerator_.stop();
        if (core_) pw_core_disconnect(core_);
        pw_thread_loop_unlock(loop_);

        pw_thread_loop_stop(loop_);
        pw_context_destroy(context_);
        pw_thread_loop_destroy(loop_);
    }

    pw_deinit();
}

std::vector<AudioSourceInfo> PwAudioSource::list_sources() {
    return enumerator_.get_sources();
}

bool PwAudioSource::start_capture(uint32_t source_id) {
    stop_capture();

    // A sink is captured through its monitor (everything playing on that device).
    // An application stream has to be tapped directly — see create_app_stream().
    const std::string media_class = enumerator_.get_media_class(source_id);
    const bool is_sink = media_class.find("Audio/Sink") != std::string::npos;

    pw_thread_loop_lock(loop_);
    if (is_sink) {
        create_monitor_stream(source_id);
    } else {
        create_app_stream(source_id);
    }
    pw_thread_loop_unlock(loop_);

    capturing_ = true;
    LOG_INFO("Started capture for source " + std::to_string(source_id) +
             (is_sink ? " (device monitor)" : " (per-application)"));
    return true;
}

void PwAudioSource::stop_capture() {
    if (!capturing_) return;
    capturing_ = false;

    pw_thread_loop_lock(loop_);
    destroy_links();
    destroy_stream();
    target_node_id_ = SPA_ID_INVALID;
    capture_node_id_ = SPA_ID_INVALID;
    pw_thread_loop_unlock(loop_);

    buffer_.clear();
    LOG_INFO("Stopped capture");
}

void PwAudioSource::on_source_list_changed(SourceChangeCallback cb) {
    source_change_cb_ = std::move(cb);
    enumerator_.on_change([this]() {
        if (source_change_cb_) {
            source_change_cb_(enumerator_.get_sources());
        }
    });
}

void PwAudioSource::create_monitor_stream(uint32_t sink_id) {
    target_node_id_ = SPA_ID_INVALID;

    struct pw_properties* props = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio",
        PW_KEY_MEDIA_CATEGORY, "Capture",
        PW_KEY_MEDIA_ROLE, "Music",
        PW_KEY_STREAM_CAPTURE_SINK, "true",
        PW_KEY_TARGET_OBJECT, std::to_string(sink_id).c_str(),
        nullptr
    );

    connect_stream(props, true, 1);
}

/**
 * Per-application capture.
 *
 * The session manager will not route a capture stream to an application's output
 * node (`pw-record --target <app>` fails with "no target node available"), so the
 * links have to be created by hand.
 *
 * Unlike the monitor path there is no peer to negotiate a channel layout with, and
 * the adapter derives its DSP ports from the requested format. Asking for stereo is
 * therefore what gives us positioned FL/FR ports to link the application's channels
 * to one-to-one; on_process() folds them down to the mono the pipeline expects.
 *
 * Linking to the application's output ports taps its audio without diverting it —
 * an output port feeds any number of links, so playback stays audible.
 */
void PwAudioSource::create_app_stream(uint32_t app_node_id) {
    target_node_id_ = app_node_id;

    struct pw_properties* props = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio",
        PW_KEY_MEDIA_CATEGORY, "Capture",
        PW_KEY_MEDIA_ROLE, "Music",
        PW_KEY_NODE_AUTOCONNECT, "false",
        nullptr
    );

    connect_stream(props, false, 2);
    // The stream node usually is not registered yet; on_port_added() finishes the job.
    link_target_ports();
}

void PwAudioSource::connect_stream(struct pw_properties* props, bool autoconnect,
                                   uint32_t channels) {
    stream_ = pw_stream_new(core_, "ai-subtitles-capture", props);

    spa_zero(stream_listener_);
    pw_stream_add_listener(stream_, &stream_listener_, &stream_events, this);

    // Request F32 format - let PipeWire handle conversion
    uint8_t buf[1024];
    struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buf, sizeof(buf));
    const struct spa_pod* params[1];

    struct spa_audio_info_raw raw_info = {};
    raw_info.format = SPA_AUDIO_FORMAT_F32;
    raw_info.rate = 16000;
    raw_info.channels = channels;
    if (channels == 2) {
        raw_info.position[0] = SPA_AUDIO_CHANNEL_FL;
        raw_info.position[1] = SPA_AUDIO_CHANNEL_FR;
    }

    params[0] = spa_format_audio_raw_build(&b, SPA_PARAM_EnumFormat, &raw_info);

    uint32_t flags = PW_STREAM_FLAG_MAP_BUFFERS | PW_STREAM_FLAG_RT_PROCESS;
    if (autoconnect) flags |= PW_STREAM_FLAG_AUTOCONNECT;

    pw_stream_connect(stream_,
        PW_DIRECTION_INPUT,
        PW_ID_ANY,
        static_cast<pw_stream_flags>(flags),
        params, 1);

    capture_node_id_ = pw_stream_get_node_id(stream_);
}

void PwAudioSource::destroy_stream() {
    if (stream_) {
        spa_hook_remove(&stream_listener_);
        pw_stream_destroy(stream_);
        stream_ = nullptr;
    }
}

/**
 * Choose which of the application's ports feed one of our capture channels.
 *
 * At most two are picked: the nearest matching channel, plus centre — where the
 * dialogue sits in a surround mix. PipeWire sums every link into a port while
 * on_process() only divides by the capture channel count, so folding in more than
 * that would risk clipping. LFE is never picked; it carries no speech.
 */
static std::vector<PwPortInfo> sources_for_channel(const std::vector<PwPortInfo>& outputs,
                                                   const std::string& dst) {
    auto first_of = [&outputs](std::initializer_list<const char*> channels) -> const PwPortInfo* {
        for (const char* channel : channels) {
            for (const auto& port : outputs) {
                if (port.channel == channel) return &port;
            }
        }
        return nullptr;
    };

    const bool right = (dst == "FR" || dst == "RR" || dst == "SR");
    const PwPortInfo* direct = right ? first_of({"FR", "RR", "SR"})
                                     : first_of({"FL", "RL", "SL"});
    // A mono or unpositioned application feeds both sides.
    if (!direct) direct = first_of({"MONO", "UNK", ""});

    std::vector<PwPortInfo> result;
    if (direct) result.push_back(*direct);
    if (const PwPortInfo* centre = first_of({"FC"})) result.push_back(*centre);
    return result;
}

void PwAudioSource::link_target_ports() {
    if (target_node_id_ == SPA_ID_INVALID || capture_node_id_ == SPA_ID_INVALID) return;

    const auto inputs = enumerator_.get_ports(capture_node_id_, false);
    const auto outputs = enumerator_.get_ports(target_node_id_, true);
    if (inputs.empty() || outputs.empty()) return;

    for (const auto& input : inputs) {
        for (const auto& output : sources_for_channel(outputs, input.channel)) {
            const auto pair = std::make_pair(output.id, input.id);
            if (linked_pairs_.count(pair)) continue;
            if (create_link(output, input)) linked_pairs_.insert(pair);
        }
    }
}

bool PwAudioSource::create_link(const PwPortInfo& output, const PwPortInfo& input) {
    struct pw_properties* props = pw_properties_new(
        PW_KEY_LINK_OUTPUT_NODE, std::to_string(output.node_id).c_str(),
        PW_KEY_LINK_OUTPUT_PORT, std::to_string(output.id).c_str(),
        PW_KEY_LINK_INPUT_NODE, std::to_string(input.node_id).c_str(),
        PW_KEY_LINK_INPUT_PORT, std::to_string(input.id).c_str(),
        // Without this the link outlives the backend process.
        PW_KEY_OBJECT_LINGER, "false",
        nullptr
    );

    auto* link = static_cast<struct pw_proxy*>(pw_core_create_object(
        core_, "link-factory", PW_TYPE_INTERFACE_Link, PW_VERSION_LINK, &props->dict, 0));
    pw_properties_free(props);

    if (!link) {
        LOG_WARN("Failed to link port " + std::to_string(output.id) + " -> " +
                 std::to_string(input.id));
        return false;
    }

    links_.push_back(link);
    LOG_INFO("Linked application port " + std::to_string(output.id) +
             (output.channel.empty() ? "" : " (" + output.channel + ")") +
             " -> capture port " + std::to_string(input.id));
    return true;
}

void PwAudioSource::destroy_links() {
    for (auto* link : links_) {
        pw_proxy_destroy(link);
    }
    links_.clear();
    linked_pairs_.clear();
}

void PwAudioSource::on_process(void* userdata) {
    auto* self = static_cast<PwAudioSource*>(userdata);
    if (!self->capturing_) return;

    struct pw_buffer* b = pw_stream_dequeue_buffer(self->stream_);
    if (!b) return;

    struct spa_buffer* buf = b->buffer;
    if (!buf->datas[0].data) {
        pw_stream_queue_buffer(self->stream_, b);
        return;
    }

    auto* samples = static_cast<const float*>(buf->datas[0].data);
    uint32_t n_samples = buf->datas[0].chunk->size / sizeof(float);
    const uint32_t channels = self->source_channels_.load(std::memory_order_relaxed);

    if (n_samples > 0) {
        if (channels <= 1) {
            self->buffer_.write(samples, n_samples);
        } else {
            // Per-application capture negotiates stereo so each of the application's
            // channels gets its own link; the pipeline downstream wants mono.
            constexpr uint32_t kChunk = 512;
            float mono[kChunk];
            const uint32_t frames = n_samples / channels;
            for (uint32_t i = 0; i < frames;) {
                const uint32_t n = std::min(kChunk, frames - i);
                for (uint32_t j = 0; j < n; ++j) {
                    const float* frame = samples + (i + j) * channels;
                    float sum = 0.0f;
                    for (uint32_t c = 0; c < channels; ++c) sum += frame[c];
                    mono[j] = sum / static_cast<float>(channels);
                }
                self->buffer_.write(mono, n);
                i += n;
            }
        }
    }

    pw_stream_queue_buffer(self->stream_, b);
}

void PwAudioSource::on_stream_state_changed(void* userdata, enum pw_stream_state /*old*/,
                                            enum pw_stream_state state, const char* error) {
    auto* self = static_cast<PwAudioSource*>(userdata);

    if (state == PW_STREAM_STATE_ERROR) {
        LOG_ERROR(std::string("Capture stream error: ") + (error ? error : "unknown"));
        return;
    }
    if (state != PW_STREAM_STATE_PAUSED && state != PW_STREAM_STATE_STREAMING) return;

    // The node id only becomes valid once the server has created the node.
    if (self->stream_) self->capture_node_id_ = pw_stream_get_node_id(self->stream_);
    self->link_target_ports();
}

void PwAudioSource::on_stream_param_changed(void* userdata, uint32_t id,
                                              const struct spa_pod* param) {
    if (!param || id != SPA_PARAM_Format) return;

    struct spa_audio_info_raw info;
    if (spa_format_audio_raw_parse(param, &info) < 0) return;

    auto* self = static_cast<PwAudioSource*>(userdata);
    self->source_rate_ = info.rate;
    self->source_channels_ = info.channels;

    LOG_INFO("Stream format: " + std::to_string(info.rate) + "Hz, " +
             std::to_string(info.channels) + "ch, format=" +
             std::to_string(info.format));
}

} // namespace ais
