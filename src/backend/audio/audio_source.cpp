#include "audio/audio_source.h"
#include <json.hpp>

namespace ais {

nlohmann::json AudioSourceInfo::to_json() const {
    return {{"id", id}, {"name", name}, {"desc", description}, {"class", media_class}};
}

} // namespace ais
