#include "audio/pipewire/pw_audio_source.h"
#include "core/logger.h"

#include <spa/param/audio/format-utils.h>
#include <spa/param/props.h>
#include <spa/pod/builder.h>

#include <cstring>
#include <cmath>

namespace ais {

static const struct pw_stream_events stream_events = {
    .version = PW_VERSION_STREAM_EVENTS,
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

    // STREAM_CAPTURE_SINK only works correctly when targeting a Sink node.
    // If the user selected an app stream (Stream/Output/Audio), resolve to the
    // sink that receives its audio so the monitor capture works properly.
    uint32_t target_id = source_id;
    std::string media_class = enumerator_.get_media_class(source_id);
    if (media_class.find("Audio/Sink") == std::string::npos) {
        // Target is an app stream, not a sink. Find the first available sink
        // to capture from (the app's audio flows through it to the speakers).
        auto sources = enumerator_.get_sources();
        for (const auto& s : sources) {
            if (s.media_class.find("Audio/Sink") != std::string::npos) {
                LOG_INFO("App stream selected (node " + std::to_string(source_id)
                         + "), capturing from sink: [" + std::to_string(s.id) + "] " + s.name);
                target_id = s.id;
                break;
            }
        }
    }

    pw_thread_loop_lock(loop_);
    create_stream(target_id);
    pw_thread_loop_unlock(loop_);

    capturing_ = true;
    LOG_INFO("Started capture for source " + std::to_string(source_id));
    return true;
}

void PwAudioSource::stop_capture() {
    if (!capturing_) return;
    capturing_ = false;

    pw_thread_loop_lock(loop_);
    destroy_stream();
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

void PwAudioSource::create_stream(uint32_t target_id) {
    struct pw_properties* props = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio",
        PW_KEY_MEDIA_CATEGORY, "Capture",
        PW_KEY_MEDIA_ROLE, "Music",
        PW_KEY_STREAM_CAPTURE_SINK, "true",
        PW_KEY_TARGET_OBJECT, std::to_string(target_id).c_str(),
        nullptr
    );

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
    raw_info.channels = 1;

    params[0] = spa_format_audio_raw_build(&b, SPA_PARAM_EnumFormat, &raw_info);

    pw_stream_connect(stream_,
        PW_DIRECTION_INPUT,
        PW_ID_ANY,
        static_cast<pw_stream_flags>(
            PW_STREAM_FLAG_AUTOCONNECT |
            PW_STREAM_FLAG_MAP_BUFFERS |
            PW_STREAM_FLAG_RT_PROCESS
        ),
        params, 1);
}

void PwAudioSource::destroy_stream() {
    if (stream_) {
        spa_hook_remove(&stream_listener_);
        pw_stream_destroy(stream_);
        stream_ = nullptr;
    }
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

    if (n_samples > 0) {
        self->buffer_.write(samples, n_samples);
    }

    pw_stream_queue_buffer(self->stream_, b);
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
