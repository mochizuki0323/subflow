#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include <json.hpp>

namespace ais {

struct AudioSourceInfo {
    uint32_t id;
    std::string name;
    std::string description;
    std::string media_class;

    nlohmann::json to_json() const;
};

class AudioRingBuffer;

class IAudioSource {
public:
    virtual ~IAudioSource() = default;

    virtual std::vector<AudioSourceInfo> list_sources() = 0;
    virtual bool start_capture(uint32_t source_id) = 0;
    virtual void stop_capture() = 0;
    virtual AudioRingBuffer& get_buffer() = 0;

    using SourceChangeCallback = std::function<void(std::vector<AudioSourceInfo>)>;
    virtual void on_source_list_changed(SourceChangeCallback cb) = 0;
};

std::unique_ptr<IAudioSource> create_audio_source();

} // namespace ais
