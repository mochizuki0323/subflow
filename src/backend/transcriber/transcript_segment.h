#pragma once
#include <string>
#include <cstdint>
#include <json.hpp>

namespace ais {

struct TranscriptSegment {
    std::string text;
    std::string translated_text;  // Used in bilingual mode
    int64_t t0_ms = 0;
    int64_t t1_ms = 0;
    bool is_partial = false;
    int speaker = -1;  // -1 = unknown/diarization not enabled

    nlohmann::json to_json() const {
        nlohmann::json j = {
            {"text", text},
            {"t0", t0_ms},
            {"t1", t1_ms},
            {"partial", is_partial}
        };
        if (!translated_text.empty()) {
            j["translated_text"] = translated_text;
        }
        if (speaker >= 0) {
            j["speaker"] = speaker;
        }
        return j;
    }
};

} // namespace ais
