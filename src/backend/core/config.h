#pragma once
#include <cstdint>
#include <string>

namespace ais {

struct Config {
    int ws_port = 9876;

    // STT provider: "deepgram" or "gladia"
    std::string provider = "deepgram";

    // Deepgram API key for cloud speech-to-text.
    // Obtain from https://console.deepgram.com/
    std::string deepgram_api_key;
    std::string deepgram_model = "nova-3";
    // Extra URL query params appended verbatim, e.g. "smart_format=true&punctuate=true"
    std::string deepgram_extra_params;

    // Gladia API key for cloud speech-to-text.
    // Obtain from https://app.gladia.io/
    std::string gladia_api_key;
    std::string gladia_model = "solaria-1";
    // JSON string of Gladia feature configuration
    std::string gladia_config;

    std::string language = "auto";
    bool translate = false;  // kept for API compat; translation is done by the LLM frontend
    std::string subtitle_mode = "original"; // "original", "translated", "bilingual"
    uint32_t audio_source_id = 0;

    // Speech enhancement / denoising
    bool denoise_enabled = false;
    std::string denoise_model_path;       // full path to .onnx model file
    std::string denoise_architecture;     // "gtcrn" or "dpdfnet"
    std::string models_dir;               // directory for downloaded models
};

} // namespace ais
