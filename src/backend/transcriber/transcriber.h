#pragma once
#include "transcriber/transcript_segment.h"
#include <string>
#include <vector>

namespace ais {

class ITranscriber {
public:
    virtual ~ITranscriber() = default;
    virtual bool load_model(const std::string& path) = 0;
    virtual void set_language(const std::string& lang) = 0;
    virtual void set_translate(bool translate) = 0;
    virtual void feed_audio(const float* samples, size_t count) = 0;
    virtual std::vector<TranscriptSegment> process() = 0;
    virtual bool is_model_loaded() const = 0;
};

} // namespace ais
