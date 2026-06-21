#pragma once
#include <string>
#include <json.hpp>

#ifdef ERROR
#undef ERROR
#endif

namespace ais {

using json = nlohmann::json;

// Backend -> Frontend message types
namespace msg {
    constexpr const char* TRANSCRIPT = "transcript";
    constexpr const char* SOURCES    = "sources";
    constexpr const char* STATUS     = "status";
    constexpr const char* LOG        = "log";
    constexpr const char* MODEL_LOADED = "model_loaded";
    // Name ERR not ERROR — Windows headers #define ERROR; wire value stays "error"
    constexpr const char* ERR = "error";
}

// Frontend -> Backend command types
namespace cmd {
    constexpr const char* SELECT_SOURCE = "select_source";
    constexpr const char* LOAD_MODEL    = "load_model";
    constexpr const char* SET_LANGUAGE  = "set_language";
    constexpr const char* SET_TRANSLATE = "set_translate";
    constexpr const char* LIST_SOURCES  = "list_sources";
    constexpr const char* SET_SUBTITLE_MODE = "set_subtitle_mode";
    constexpr const char* START         = "start";
    constexpr const char* STOP          = "stop";
    constexpr const char* SET_DENOISE   = "set_denoise";
    constexpr const char* SET_VAD       = "set_vad";
}

inline json make_message(const std::string& type, const json& data) {
    return {{"type", type}, {"data", data}};
}

} // namespace ais
