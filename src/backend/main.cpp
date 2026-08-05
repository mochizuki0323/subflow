#include "core/logger.h"
#include "core/engine.h"
#include "core/config.h"

#include <atomic>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>

// Atomic, not a plain pointer: a process-directed signal may be delivered on
// any thread, so the handler's read can genuinely race the main thread's write.
static std::atomic<ais::Engine*> g_engine{nullptr};
// Set even when there is no engine yet to tell. Installing a handler replaces
// the default terminate action, so a signal arriving before the engine exists
// used to be swallowed outright and the process became unkillable by SIGTERM.
static std::atomic<bool> g_stop_requested{false};

// Everything the handler touches has to be lock-free, or it could deadlock
// against the very thread it interrupted.
static_assert(std::atomic<ais::Engine*>::is_always_lock_free,
              "signal handler stores to g_engine");
static_assert(std::atomic<bool>::is_always_lock_free,
              "signal handler stores to g_stop_requested");

// Both providers expose a thread count over the same 1-8 range, so they share
// one reader. atoi, not stoi: a malformed value must not abort a backend that
// Electron spawned with no way to explain the SIGABRT. Out of range clamps
// rather than falling back, because the config layer above clamps too and the
// two ends resolving the same number differently is worse than either rule.
// Zero and negatives cannot be told apart from atoi's parse failure, so those
// alone take the default.
static int read_threads(const char* value, int fallback) {
    const int n = std::atoi(value);
    if (n <= 0) return fallback;
    return n > 8 ? 8 : n;
}

static void signal_handler(int) {
    // Flag only. Tearing the engine down from here ran concurrently with run()
    // still starting it up: the stop reached a WebSocket server that did not
    // exist yet, run() then created it, and the result was a process listening
    // on the port with no pipeline behind it and no way left to stop it.
    g_stop_requested.store(true, std::memory_order_relaxed);
    ais::Engine* engine = g_engine.load(std::memory_order_acquire);
    if (engine) engine->request_stop();
}

static void print_usage(const char* argv0) {
    std::cerr << "Usage: " << argv0 << " [options]\n"
              << "Options:\n"
              << "  --port <port>              WebSocket port (default: 9876)\n"
              << "  --provider <name>          STT provider: parakeet, nemotron or remote_parakeet (default: parakeet)\n"
              << "  --language <lang>          Language code: ja, en, zh, auto, etc. (default: auto)\n"
              << "  --nemotron-model-dir <dir>  Nemotron streaming model directory\n"
              << "  --nemotron-threads <n>      Nemotron decode threads, 1-8 (default: 2)\n"
              << "  --nemotron-min-silence <f>  Trailing silence sec that ends an utterance (default: 1.2)\n"
              << "  --nemotron-max-utterance <f> Max utterance sec before force-cut (default: 15)\n"
              << "  --parakeet-model-dir <dir>  Parakeet model directory\n"
              << "  --parakeet-model-type <t>   Parakeet model type: nemo_ctc or nemo_transducer\n"
              << "  --parakeet-vad-model <path> Path to silero_vad.onnx\n"
              << "  --parakeet-threads <n>      Parakeet decode threads, 1-8 (default: 4)\n"
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
            config.nemotron_threads = read_threads(argv[++i], 2);
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
        } else if (std::strcmp(argv[i], "--parakeet-threads") == 0 && i + 1 < argc) {
            config.parakeet_threads = read_threads(argv[++i], 4);
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
    g_engine.store(&engine, std::memory_order_release);

    // A signal that landed while the engine was being constructed found no
    // engine to tell; honour it here rather than starting up in order to shut
    // straight back down.
    if (g_stop_requested.load(std::memory_order_relaxed)) {
        LOG_INFO("Stop requested during startup; exiting without starting.");
    } else {
        engine.run();
    }

    // The engine is about to be destroyed; a late signal must not reach it.
    g_engine.store(nullptr, std::memory_order_release);

    LOG_INFO("Shutdown complete.");
    // Non-zero so the supervisor retries: a taken port is somebody else's
    // backend still letting go, which a second attempt usually resolves. A
    // clean exit would be taken as "asked to stop" and left alone.
    return engine.listen_failed() ? 1 : 0;
}
