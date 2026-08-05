#include "core/logger.h"
#include "core/engine.h"
#include "core/config.h"

#include <csignal>
#include <cstring>
#include <iostream>
#include <string>

static ais::Engine* g_engine = nullptr;

static void signal_handler(int sig) {
    if (g_engine) {
        LOG_INFO("Received signal " + std::to_string(sig) + ", shutting down...");
        g_engine->stop();
    }
}

static void print_usage(const char* argv0) {
    std::cerr << "Usage: " << argv0 << " [options]\n"
              << "Options:\n"
              << "  --port <port>              WebSocket port (default: 9876)\n"
              << "  --provider <name>          STT provider: parakeet, nemotron or remote_parakeet (default: parakeet)\n"
              << "  --language <lang>          Language code: ja, en, zh, auto, etc. (default: auto)\n"
              << "  --nemotron-model-dir <dir>  Nemotron streaming model directory\n"
              << "  --nemotron-threads <n>      Nemotron decode threads, 1-8 (default: 2)\n"
              << "  --nemotron-min-silence <f>  Trailing silence sec that ends an utterance (default: 0.5)\n"
              << "  --nemotron-max-utterance <f> Max utterance sec before force-cut (default: 15)\n"
              << "  --parakeet-model-dir <dir>  Parakeet model directory\n"
              << "  --parakeet-model-type <t>   Parakeet model type: nemo_ctc or nemo_transducer\n"
              << "  --parakeet-vad-model <path> Path to silero_vad.onnx\n"
              << "  --remote-parakeet-url <url>     Remote Parakeet server URL (ws:// or wss://)\n"
              << "  --remote-parakeet-api-key <key> Bearer token for the remote Parakeet server\n"
              << "  --remote-parakeet-model <id>    Model id to select on the remote server\n"
              << "  --parakeet-vad-threshold <f>     Silero VAD speech threshold (default: 0.3)\n"
              << "  --parakeet-vad-min-silence <f>   Min silence sec to close a segment (default: 0.5)\n"
              << "  --parakeet-vad-min-speech <f>    Min speech sec to accept a segment (default: 0.25)\n"
              << "  --parakeet-vad-max-speech <f>    Max speech sec before force-cut (default: 15)\n"
              << "  --parakeet-partial-interval <f>  Interim re-decode period sec (default: 0.2)\n"
              << "  --denoise                  Enable speech denoising\n"
              << "  --denoise-model <path>     Path to denoise ONNX model\n"
              << "  --denoise-arch <arch>      Denoise architecture: gtcrn or dpdfnet\n"
              << "  --models-dir <dir>         Directory for downloaded models\n"
              << "  --help                     Show this help\n";
}

int main(int argc, char* argv[]) {
    ais::Config config;

    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            config.ws_port = std::stoi(argv[++i]);
        } else if (std::strcmp(argv[i], "--provider") == 0 && i + 1 < argc) {
            config.provider = argv[++i];
        } else if (std::strcmp(argv[i], "--language") == 0 && i + 1 < argc) {
            config.language = argv[++i];
        } else if (std::strcmp(argv[i], "--nemotron-model-dir") == 0 && i + 1 < argc) {
            config.nemotron_model_dir = argv[++i];
        } else if (std::strcmp(argv[i], "--nemotron-threads") == 0 && i + 1 < argc) {
            int n = std::atoi(argv[++i]);
            config.nemotron_threads = (n >= 1 && n <= 8) ? n : 2;
        } else if (std::strcmp(argv[i], "--nemotron-min-silence") == 0 && i + 1 < argc) {
            config.nemotron_min_silence = std::stof(argv[++i]);
        } else if (std::strcmp(argv[i], "--nemotron-max-utterance") == 0 && i + 1 < argc) {
            config.nemotron_max_utterance = std::stof(argv[++i]);
        } else if (std::strcmp(argv[i], "--parakeet-model-dir") == 0 && i + 1 < argc) {
            config.parakeet_model_dir = argv[++i];
        } else if (std::strcmp(argv[i], "--parakeet-model-type") == 0 && i + 1 < argc) {
            config.parakeet_model_type = argv[++i];
        } else if (std::strcmp(argv[i], "--parakeet-vad-model") == 0 && i + 1 < argc) {
            config.parakeet_vad_model = argv[++i];
        } else if (std::strcmp(argv[i], "--remote-parakeet-url") == 0 && i + 1 < argc) {
            config.remote_parakeet_url = argv[++i];
        } else if (std::strcmp(argv[i], "--remote-parakeet-api-key") == 0 && i + 1 < argc) {
            config.remote_parakeet_api_key = argv[++i];
        } else if (std::strcmp(argv[i], "--remote-parakeet-model") == 0 && i + 1 < argc) {
            config.remote_parakeet_model = argv[++i];
        } else if (std::strcmp(argv[i], "--parakeet-vad-threshold") == 0 && i + 1 < argc) {
            config.parakeet_vad_threshold = std::stof(argv[++i]);
        } else if (std::strcmp(argv[i], "--parakeet-vad-min-silence") == 0 && i + 1 < argc) {
            config.parakeet_vad_min_silence = std::stof(argv[++i]);
        } else if (std::strcmp(argv[i], "--parakeet-vad-min-speech") == 0 && i + 1 < argc) {
            config.parakeet_vad_min_speech = std::stof(argv[++i]);
        } else if (std::strcmp(argv[i], "--parakeet-vad-max-speech") == 0 && i + 1 < argc) {
            config.parakeet_vad_max_speech = std::stof(argv[++i]);
        } else if (std::strcmp(argv[i], "--parakeet-partial-interval") == 0 && i + 1 < argc) {
            config.parakeet_partial_interval = std::stof(argv[++i]);
        } else if (std::strcmp(argv[i], "--denoise") == 0) {
            config.denoise_enabled = true;
        } else if (std::strcmp(argv[i], "--denoise-model") == 0 && i + 1 < argc) {
            config.denoise_model_path = argv[++i];
        } else if (std::strcmp(argv[i], "--denoise-arch") == 0 && i + 1 < argc) {
            config.denoise_architecture = argv[++i];
        } else if (std::strcmp(argv[i], "--models-dir") == 0 && i + 1 < argc) {
            config.models_dir = argv[++i];
        } else if (std::strcmp(argv[i], "--help") == 0) {
            print_usage(argv[0]);
            return 0;
        } else {
            std::cerr << "Unknown option: " << argv[i] << "\n";
            print_usage(argv[0]);
            return 1;
        }
    }

    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    LOG_INFO("SubFlow backend starting (provider=" + config.provider + ")...");
    LOG_INFO("WebSocket port: " + std::to_string(config.ws_port));
    if (config.provider == "remote_parakeet") {
        if (!config.remote_parakeet_url.empty())
            LOG_INFO("Remote Parakeet server: " + config.remote_parakeet_url);
        else
            LOG_WARN("Remote Parakeet URL: NOT SET — transcription disabled until a server is configured");
    } else if (config.provider == "nemotron") {
        if (!config.nemotron_model_dir.empty())
            LOG_INFO("Nemotron streaming model: " + config.nemotron_model_dir);
        else
            LOG_WARN("Nemotron model directory: NOT SET — transcription disabled until model is downloaded");
    } else {
        if (!config.parakeet_model_dir.empty())
            LOG_INFO("Parakeet model: " + config.parakeet_model_dir + " (type=" + config.parakeet_model_type + ")");
        else
            LOG_WARN("Parakeet model directory: NOT SET — transcription disabled until model is downloaded");
    }

    ais::Engine engine(config);
    g_engine = &engine;

    engine.run();

    g_engine = nullptr;
    LOG_INFO("Shutdown complete.");
    return 0;
}
