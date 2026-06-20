#pragma once
#include <cstdint>
#include <string>

namespace ais {

struct Config {
    int ws_port = 9876;

    // STT provider: "deepgram", "gladia", or "parakeet"
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

    // Parakeet local ASR model
    std::string parakeet_model_dir;       // directory containing extracted model files
    std::string parakeet_model_type;      // "nemo_ctc" or "nemo_transducer"
    std::string parakeet_vad_model;       // path to silero_vad.onnx

    // Parakeet VAD tuning (Silero VAD + simulated streaming). Durations in seconds.
    float parakeet_vad_threshold = 0.3f;
    float parakeet_vad_min_silence = 0.5f;
    float parakeet_vad_min_speech = 0.25f;
    float parakeet_vad_max_speech = 15.0f;
    float parakeet_partial_interval = 0.2f;

    // Remote Parakeet inference server (provider "remote_parakeet")
    std::string remote_parakeet_url;       // ws:// or wss:// server URL
    std::string remote_parakeet_api_key;   // optional Bearer token

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
