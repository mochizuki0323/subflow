#pragma once
#include "audio/audio_source.h"
#include "audio/audio_buffer.h"

#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ais {

class WasapiAudioSource : public IAudioSource {
public:
    WasapiAudioSource();
    ~WasapiAudioSource() override;

    std::vector<AudioSourceInfo> list_sources() override;
    bool start_capture(uint32_t source_id) override;
    void stop_capture() override;
    AudioRingBuffer& get_buffer() override { return buffer_; }
    void on_source_list_changed(SourceChangeCallback cb) override;

private:
    struct SourceEntry {
        std::wstring device_id;
        bool loopback;
        bool is_process;
        uint32_t process_id;
        std::string description;
        std::string media_class;
    };

    void capture_thread_main(uint32_t source_id);
    void capture_device(const SourceEntry& entry);
    bool capture_process(const SourceEntry& entry);
    void push_resampled_mono(const float* interleaved, size_t frame_count,
                             uint32_t channels, uint32_t sample_rate);

    AudioRingBuffer buffer_;
    SourceChangeCallback source_change_cb_;

    std::mutex list_mutex_;
    std::vector<SourceEntry> sources_;

    std::atomic<bool> capturing_{false};
    std::thread capture_thread_;

    bool com_inited_{false};

    std::vector<float> resample_pending_;
    double resample_phase_{0};
};

} // namespace ais
