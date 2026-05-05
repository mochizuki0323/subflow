#pragma once
#include <string>
#include <vector>
#include <json.hpp>

namespace ais {

struct DenoiseModelInfo {
    std::string id;
    std::string filename;
    std::string architecture; // "gtcrn" or "dpdfnet"
    int sample_rate = 16000;
    int64_t size_bytes = 0;
    std::string description_en;
    std::string description_zh;
};

inline std::vector<DenoiseModelInfo> parse_denoise_model_registry(const nlohmann::json& j) {
    std::vector<DenoiseModelInfo> models;
    if (!j.contains("models") || !j["models"].is_array()) return models;
    for (const auto& m : j["models"]) {
        DenoiseModelInfo info;
        info.id = m.value("id", "");
        info.filename = m.value("filename", "");
        info.architecture = m.value("architecture", "");
        info.sample_rate = m.value("sample_rate", 16000);
        info.size_bytes = m.value("size_bytes", int64_t(0));
        info.description_en = m.value("description_en", "");
        info.description_zh = m.value("description_zh", "");
        if (!info.id.empty() && !info.filename.empty() && !info.architecture.empty()) {
            models.push_back(std::move(info));
        }
    }
    return models;
}

inline nlohmann::json denoise_model_info_to_json(const DenoiseModelInfo& info) {
    return {
        {"id", info.id},
        {"filename", info.filename},
        {"architecture", info.architecture},
        {"sample_rate", info.sample_rate},
        {"size_bytes", info.size_bytes},
        {"description_en", info.description_en},
        {"description_zh", info.description_zh}
    };
}

} // namespace ais
