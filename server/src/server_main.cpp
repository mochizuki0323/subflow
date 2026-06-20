// Standalone Parakeet inference server entry point.
//
// Wires together one shared ParakeetModel (recognizer), one DecodeScheduler
// (single batched dispatcher), and the uWS-based ParakeetWsServer that gives each
// connection its own VAD session. Config comes from CLI flags, each with an
// environment-variable fallback so the same binary is convenient both for local
// runs and for container/systemd deployment.
#include "log.h"
#include "parakeet_model.h"
#include "decode_scheduler.h"
#include "parakeet_ws_server.h"

#include <csignal>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>

namespace {

ais::ParakeetWsServer* g_server = nullptr;

void signal_handler(int sig) {
    LOG_INFO("Received signal " + std::to_string(sig) + ", shutting down...");
    if (g_server) g_server->stop();
}

std::string env_or(const char* key, const std::string& fallback) {
    const char* v = std::getenv(key);
    return v ? std::string(v) : fallback;
}

void print_usage(const char* argv0) {
    std::cerr <<
        "Usage: " << argv0 << " [options]\n"
        "Parakeet ASR inference server (WebSocket, server-side VAD).\n\n"
        "Options (env fallback in parentheses):\n"
        "  --port <n>                 Listen port (PARAKEET_PORT, default 9090)\n"
        "  --api-key <key>            Bearer token required from clients (PARAKEET_API_KEY); empty = no auth\n"
        "  --model-dir <dir>          Parakeet model directory (PARAKEET_MODEL_DIR) [required]\n"
        "  --model-type <t>           nemo_ctc | nemo_transducer (PARAKEET_MODEL_TYPE, default nemo_transducer)\n"
        "  --vad-model <path>         Path to silero_vad.onnx (PARAKEET_VAD_MODEL) [required]\n"
        "  --provider <p>             onnxruntime provider: cpu | cuda (PARAKEET_PROVIDER, default cpu)\n"
        "  --num-threads <n>          Recognizer intra-op threads (PARAKEET_NUM_THREADS, default 4)\n"
        "  --max-sessions <n>         Max concurrent connections (PARAKEET_MAX_SESSIONS, default 64)\n"
        "  --max-batch <n>            Max utterances per batched decode (PARAKEET_MAX_BATCH, default 8)\n"
        "  --vad-threshold <f>        Silero speech threshold (default 0.3)\n"
        "  --vad-min-silence <f>      Min silence sec to close a segment (default 0.5)\n"
        "  --vad-min-speech <f>       Min speech sec to accept a segment (default 0.25)\n"
        "  --vad-max-speech <f>       Max speech sec before force-cut (default 15)\n"
        "  --partial-interval <f>     Interim re-decode period sec (default 0.2)\n"
        "  --help                     Show this help\n";
}

bool need_value(int i, int argc, const char* flag) {
    if (i + 1 >= argc) {
        std::cerr << "Missing value for " << flag << "\n";
        return false;
    }
    return true;
}

} // namespace

int main(int argc, char* argv[]) {
    ais::ParakeetModelConfig model_cfg;
    ais::ParakeetWsServer::Config srv_cfg;
    ais::ServerVadParams vad;
    int max_batch = std::stoi(env_or("PARAKEET_MAX_BATCH", "8"));

    srv_cfg.port = std::stoi(env_or("PARAKEET_PORT", "9090"));
    srv_cfg.api_key = env_or("PARAKEET_API_KEY", "");
    srv_cfg.max_sessions = std::stoi(env_or("PARAKEET_MAX_SESSIONS", "64"));
    srv_cfg.vad_model_path = env_or("PARAKEET_VAD_MODEL", "");
    model_cfg.model_dir = env_or("PARAKEET_MODEL_DIR", "");
    model_cfg.model_type = env_or("PARAKEET_MODEL_TYPE", "nemo_transducer");
    model_cfg.provider = env_or("PARAKEET_PROVIDER", "cpu");
    model_cfg.num_threads = std::stoi(env_or("PARAKEET_NUM_THREADS", "4"));

    for (int i = 1; i < argc; ++i) {
        const char* a = argv[i];
        auto val = [&]() -> const char* { return argv[++i]; };
        if (!std::strcmp(a, "--port") && need_value(i, argc, a)) srv_cfg.port = std::stoi(val());
        else if (!std::strcmp(a, "--api-key") && need_value(i, argc, a)) srv_cfg.api_key = val();
        else if (!std::strcmp(a, "--model-dir") && need_value(i, argc, a)) model_cfg.model_dir = val();
        else if (!std::strcmp(a, "--model-type") && need_value(i, argc, a)) model_cfg.model_type = val();
        else if (!std::strcmp(a, "--vad-model") && need_value(i, argc, a)) srv_cfg.vad_model_path = val();
        else if (!std::strcmp(a, "--provider") && need_value(i, argc, a)) model_cfg.provider = val();
        else if (!std::strcmp(a, "--num-threads") && need_value(i, argc, a)) model_cfg.num_threads = std::stoi(val());
        else if (!std::strcmp(a, "--max-sessions") && need_value(i, argc, a)) srv_cfg.max_sessions = std::stoi(val());
        else if (!std::strcmp(a, "--max-batch") && need_value(i, argc, a)) max_batch = std::stoi(val());
        else if (!std::strcmp(a, "--vad-threshold") && need_value(i, argc, a)) vad.threshold = std::stof(val());
        else if (!std::strcmp(a, "--vad-min-silence") && need_value(i, argc, a)) vad.min_silence = std::stof(val());
        else if (!std::strcmp(a, "--vad-min-speech") && need_value(i, argc, a)) vad.min_speech = std::stof(val());
        else if (!std::strcmp(a, "--vad-max-speech") && need_value(i, argc, a)) vad.max_speech = std::stof(val());
        else if (!std::strcmp(a, "--partial-interval") && need_value(i, argc, a)) vad.partial_interval = std::stof(val());
        else if (!std::strcmp(a, "--help")) { print_usage(argv[0]); return 0; }
        else { std::cerr << "Unknown option: " << a << "\n"; print_usage(argv[0]); return 1; }
    }

    if (model_cfg.model_dir.empty()) {
        std::cerr << "Error: --model-dir (or PARAKEET_MODEL_DIR) is required\n";
        return 1;
    }
    if (srv_cfg.vad_model_path.empty()) {
        std::cerr << "Error: --vad-model (or PARAKEET_VAD_MODEL) is required\n";
        return 1;
    }
    srv_cfg.vad = vad;

    LOG_INFO("Parakeet server starting (port=" + std::to_string(srv_cfg.port) +
             ", model_type=" + model_cfg.model_type + ", provider=" + model_cfg.provider + ")");
    if (srv_cfg.api_key.empty()) LOG_WARN("No API key set — authentication is DISABLED");

    ais::ParakeetModel model(model_cfg);
    if (!model.load()) {
        LOG_ERROR("Failed to load Parakeet model from " + model_cfg.model_dir);
        return 1;
    }

    ais::DecodeScheduler scheduler(model, max_batch);
    scheduler.start();

    ais::ParakeetWsServer server(model, scheduler, srv_cfg);
    g_server = &server;
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    server.run();  // blocking until stop()

    g_server = nullptr;
    scheduler.stop();
    LOG_INFO("Parakeet server shutdown complete.");
    return 0;
}
