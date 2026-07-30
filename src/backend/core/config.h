#pragma once
#include <cstdint>
#include <string>

namespace ais {

struct Config {
    int ws_port = 9876;

    // STT provider: "parakeet" (local) or "remote_parakeet" (self-hosted server)
    std::string provider = "parakeet";

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
    std::string remote_parakeet_model;     // model id to select on the server (optional)

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
