// Standalone Parakeet inference server entry point.
//
// Configuration is driven by a single JSON file. By default the server looks for
// "config/config.json" next to the executable (then "./config/config.json");
// override the location with --config <path>. The JSON holds every server
// setting plus the model list. CLI flags are optional and override individual
// fields for one-off runs. Relative paths inside the JSON (vad_model, each
// model's dir) are resolved against the config file's own directory.
#include "log.h"
#include "model_registry.h"
#include "parakeet_ws_server.h"

#include <json.hpp>

#include <csignal>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#ifdef __linux__
#include <linux/limits.h>
#include <unistd.h>
#endif

namespace {

namespace fs = std::filesystem;
using json = nlohmann::json;

ais::ParakeetWsServer* g_server = nullptr;

void signal_handler(int sig) {
    LOG_INFO("Received signal " + std::to_string(sig) + ", shutting down...");
    if (g_server) g_server->stop();
}

struct ModelSpec {
    std::string id;
    std::string dir;
    std::string type;
};

// Directory containing the running executable (Linux). Empty if unavailable.
std::string exe_dir() {
#ifdef __linux__
    char buf[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (n > 0) {
        buf[n] = '\0';
        return fs::path(buf).parent_path().string();
    }
#endif
    return "";
}

void print_usage(const char* argv0) {
    std::cerr <<
        "Usage: " << argv0 << " [options]\n"
        "Parakeet ASR inference server (WebSocket, server-side VAD, multi-model).\n\n"
        "Configuration is read from a JSON file (see server/config.example.json):\n"
        "  --config <path>            Config file (default: <exe-dir>/config/config.json,\n"
        "                             then ./config/config.json)\n\n"
        "CLI flags below override the corresponding config-file fields:\n"
        "  --port <n>                 Listen port (default 9090)\n"
        "  --api-key <key>            Bearer token required from clients; empty = no auth\n"
        "  --model-dir <dir>          Add a single model; id = its folder name\n"
        "  --model-type <t>           Type for --model-dir: nemo_ctc | nemo_transducer (auto-detected if omitted)\n"
        "  --vad-model <path>         Path to silero_vad.onnx\n"
        "  --provider <p>             onnxruntime provider: cpu | cuda (default cpu)\n"
        "  --num-threads <n>          Recognizer intra-op threads (default 4)\n"
        "  --max-sessions <n>         Max concurrent connections (default 64)\n"
        "  --max-batch <n>            Max utterances per batched decode (default 8)\n"
        "  --vad-threshold <f>        Silero speech threshold (default 0.3)\n"
        "  --vad-min-silence <f>      Min silence sec to close a segment (default 0.5)\n"
        "  --vad-min-speech <f>       Min speech sec to accept a segment (default 0.25)\n"
        "  --vad-max-speech <f>       Max speech sec before force-cut (default 15)\n"
        "  --partial-interval <f>     Interim re-decode period sec (default 0.2)\n"
        "  --help                     Show this help\n\n"
        "At least one model is required, from the config file's \"models\" or --model-dir.\n";
}

bool need_value(int i, int argc, const char* flag) {
    if (i + 1 >= argc) {
        std::cerr << "Missing value for " << flag << "\n";
        return false;
    }
    return true;
}

// Apply a JSON config file onto the config structs + model list. Returns false
// on missing file / invalid JSON / type errors (the whole parse is atomic — a
// bad field aborts the load so the operator gets a clear error, not a half-config).
bool load_config_file(const std::string& path,
                      ais::ModelRegistry::BaseConfig& base,
                      ais::ParakeetWsServer::Config& srv,
                      ais::ServerVadParams& vad,
                      std::string& vad_model,
                      std::vector<ModelSpec>& models) {
    std::ifstream f(path);
    if (!f) {
        LOG_ERROR("Config: cannot open " + path);
        return false;
    }
    const fs::path base_dir = fs::path(path).parent_path();
    auto resolve = [&](const std::string& p) -> std::string {
        if (p.empty()) return p;
        fs::path pp(p);
        return pp.is_relative() ? (base_dir / pp).string() : p;
    };
    try {
        json j;
        f >> j;

        if (j.contains("port")) srv.port = j.at("port").get<int>();
        if (j.contains("api_key")) srv.api_key = j.at("api_key").get<std::string>();
        if (j.contains("max_sessions")) srv.max_sessions = j.at("max_sessions").get<int>();
        if (j.contains("provider")) base.provider = j.at("provider").get<std::string>();
        if (j.contains("num_threads")) base.num_threads = j.at("num_threads").get<int>();
        if (j.contains("max_batch")) base.max_batch = j.at("max_batch").get<int>();
        if (j.contains("vad_model")) vad_model = resolve(j.at("vad_model").get<std::string>());

        if (j.contains("vad") && j.at("vad").is_object()) {
            const auto& v = j.at("vad");
            if (v.contains("threshold")) vad.threshold = v.at("threshold").get<float>();
            if (v.contains("min_silence")) vad.min_silence = v.at("min_silence").get<float>();
            if (v.contains("min_speech")) vad.min_speech = v.at("min_speech").get<float>();
            if (v.contains("max_speech")) vad.max_speech = v.at("max_speech").get<float>();
            if (v.contains("partial_interval")) vad.partial_interval = v.at("partial_interval").get<float>();
        }

        if (j.contains("models")) {
            if (!j.at("models").is_array()) {
                LOG_ERROR("Config: \"models\" must be an array");
                return false;
            }
            for (const auto& m : j.at("models")) {
                ModelSpec s;
                s.id = m.value("id", "");
                const std::string raw_dir = m.value("dir", "");
                s.type = m.value("type", "");
                if (s.id.empty() || raw_dir.empty()) {
                    LOG_WARN("Config: skipping model entry missing \"id\" or \"dir\"");
                    continue;
                }
                s.dir = resolve(raw_dir);
                models.push_back(std::move(s));
            }
        }
    } catch (const std::exception& e) {
        LOG_ERROR(std::string("Config: invalid config file: ") + e.what());
        return false;
    }
    LOG_INFO("Config: loaded " + path);
    return true;
}

} // namespace

int main(int argc, char* argv[]) {
    ais::ModelRegistry::BaseConfig base;
    ais::ParakeetWsServer::Config srv_cfg;
    ais::ServerVadParams vad;
    std::string vad_model;
    std::vector<ModelSpec> models;
    std::string model_dir, model_type;  // single-model shortcut

    // Pass 1: resolve --config (and short-circuit --help) before loading.
    std::string config_path;
    for (int i = 1; i < argc; ++i) {
        if (!std::strcmp(argv[i], "--help")) { print_usage(argv[0]); return 0; }
        if (!std::strcmp(argv[i], "--config") && i + 1 < argc) {
            config_path = argv[++i];
        }
    }
    if (config_path.empty()) {
        std::vector<std::string> candidates;
        const std::string d = exe_dir();
        if (!d.empty()) candidates.push_back((fs::path(d) / "config" / "config.json").string());
        candidates.push_back((fs::path("config") / "config.json").string());
        for (const auto& c : candidates) {
            std::error_code ec;
            if (fs::exists(c, ec)) { config_path = c; break; }
        }
    }

    // Load the config file (its values become the base, below the CLI overrides).
    // A config that was named (--config) or auto-found but then fails to load is
    // fatal — "present but broken" must not be silently ignored. Only the genuine
    // "no config file anywhere" case falls back to CLI flags.
    if (!config_path.empty()) {
        if (!load_config_file(config_path, base, srv_cfg, vad, vad_model, models)) {
            return 1;
        }
    } else {
        LOG_WARN("No config file found (looked for <exe-dir>/config/config.json and ./config/config.json); using CLI flags only");
    }

    // Pass 2: CLI flags override individual fields.
    for (int i = 1; i < argc; ++i) {
        const char* a = argv[i];
        auto val = [&]() -> const char* { return argv[++i]; };
        if (!std::strcmp(a, "--config")) { ++i; continue; }  // already handled
        else if (!std::strcmp(a, "--port") && need_value(i, argc, a)) srv_cfg.port = std::stoi(val());
        else if (!std::strcmp(a, "--api-key") && need_value(i, argc, a)) srv_cfg.api_key = val();
        else if (!std::strcmp(a, "--model-dir") && need_value(i, argc, a)) model_dir = val();
        else if (!std::strcmp(a, "--model-type") && need_value(i, argc, a)) model_type = val();
        else if (!std::strcmp(a, "--vad-model") && need_value(i, argc, a)) vad_model = val();
        else if (!std::strcmp(a, "--provider") && need_value(i, argc, a)) base.provider = val();
        else if (!std::strcmp(a, "--num-threads") && need_value(i, argc, a)) base.num_threads = std::stoi(val());
        else if (!std::strcmp(a, "--max-sessions") && need_value(i, argc, a)) srv_cfg.max_sessions = std::stoi(val());
        else if (!std::strcmp(a, "--max-batch") && need_value(i, argc, a)) base.max_batch = std::stoi(val());
        else if (!std::strcmp(a, "--vad-threshold") && need_value(i, argc, a)) vad.threshold = std::stof(val());
        else if (!std::strcmp(a, "--vad-min-silence") && need_value(i, argc, a)) vad.min_silence = std::stof(val());
        else if (!std::strcmp(a, "--vad-min-speech") && need_value(i, argc, a)) vad.min_speech = std::stof(val());
        else if (!std::strcmp(a, "--vad-max-speech") && need_value(i, argc, a)) vad.max_speech = std::stof(val());
        else if (!std::strcmp(a, "--partial-interval") && need_value(i, argc, a)) vad.partial_interval = std::stof(val());
        else if (!std::strcmp(a, "--help")) { print_usage(argv[0]); return 0; }
        else { std::cerr << "Unknown option: " << a << "\n"; print_usage(argv[0]); return 1; }
    }

    if (models.empty() && model_dir.empty()) {
        std::cerr << "Error: no models configured — add \"models\" to the config file or pass --model-dir\n";
        return 1;
    }
    if (vad_model.empty()) {
        std::cerr << "Error: vad_model is not set (config \"vad_model\" or --vad-model)\n";
        return 1;
    }
    srv_cfg.vad_model_path = vad_model;
    srv_cfg.vad = vad;

    LOG_INFO("Parakeet server starting (port=" + std::to_string(srv_cfg.port) +
             ", provider=" + base.provider + ")");
    if (srv_cfg.api_key.empty()) LOG_WARN("No API key set — authentication is DISABLED");

    ais::ModelRegistry registry(base);
    for (const auto& s : models) registry.add_model(s.id, s.dir, s.type);
    if (!model_dir.empty()) {
        std::string id = fs::path(model_dir).filename().string();
        if (id.empty()) id = "default";
        registry.add_model(id, model_dir, model_type);
    }
    if (registry.size() == 0) {
        LOG_ERROR("No usable Parakeet models registered — check the config file / --model-dir");
        return 1;
    }
    LOG_INFO("Parakeet server serving " + std::to_string(registry.size()) +
             " model(s); weights load lazily on first use");
    registry.start();

    ais::ParakeetWsServer server(registry, srv_cfg);
    g_server = &server;
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    server.run();  // blocking until stop()

    g_server = nullptr;
    registry.stop();
    LOG_INFO("Parakeet server shutdown complete.");
    return 0;
}
