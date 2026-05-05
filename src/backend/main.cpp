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
              << "  --provider <name>          STT provider: deepgram or gladia (default: deepgram)\n"
              << "  --api-key <key>            Deepgram API key\n"
              << "  --model <model>            Deepgram model (default: nova-3)\n"
              << "  --language <lang>          Language code: ja, en, zh, auto, etc. (default: auto)\n"
              << "  --extra-params <params>    Extra Deepgram URL params\n"
              << "  --gladia-api-key <key>     Gladia API key\n"
              << "  --gladia-model <model>     Gladia model (default: solaria-1)\n"
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
        } else if (std::strcmp(argv[i], "--api-key") == 0 && i + 1 < argc) {
            config.deepgram_api_key = argv[++i];
        } else if (std::strcmp(argv[i], "--model") == 0 && i + 1 < argc) {
            config.deepgram_model = argv[++i];
        } else if (std::strcmp(argv[i], "--extra-params") == 0 && i + 1 < argc) {
            config.deepgram_extra_params = argv[++i];
        } else if (std::strcmp(argv[i], "--language") == 0 && i + 1 < argc) {
            config.language = argv[++i];
        } else if (std::strcmp(argv[i], "--gladia-api-key") == 0 && i + 1 < argc) {
            config.gladia_api_key = argv[++i];
        } else if (std::strcmp(argv[i], "--gladia-model") == 0 && i + 1 < argc) {
            config.gladia_model = argv[++i];
        } else if (std::strcmp(argv[i], "--gladia-config") == 0 && i + 1 < argc) {
            config.gladia_config = argv[++i];
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
    if (config.provider == "gladia") {
        if (!config.gladia_api_key.empty())
            LOG_INFO("Gladia API key: configured (model=" + config.gladia_model + ")");
        else
            LOG_WARN("Gladia API key: NOT SET — transcription disabled until key is provided");
    } else {
        if (!config.deepgram_api_key.empty())
            LOG_INFO("Deepgram API key: configured");
        else
            LOG_WARN("Deepgram API key: NOT SET — transcription disabled until key is provided");
    }

    ais::Engine engine(config);
    g_engine = &engine;

    engine.run();

    g_engine = nullptr;
    LOG_INFO("Shutdown complete.");
    return 0;
}
