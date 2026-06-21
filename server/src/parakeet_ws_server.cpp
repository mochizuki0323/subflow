#include "parakeet_ws_server.h"
#include "model_registry.h"
#include "decode_scheduler.h"
#include "parakeet_session.h"
#include "log.h"

#include <App.h>
#include <json.hpp>

#include <atomic>
#include <cstring>
#include <memory>
#include <set>
#include <string>

namespace ais {

using json = nlohmann::json;

namespace {
struct PerSocketData {
    std::string model_id;                       // resolved at upgrade
    std::shared_ptr<ParakeetSession> session;   // created once the model is ready
    ServerVadParams vad;                         // client-requested VAD params
    bool vad_set = false;                        // true once the client sent set_vad
};
using WsConn = uWS::WebSocket<false, true, PerSocketData>;
}  // namespace

struct ParakeetWsServer::Impl {
    Impl(ModelRegistry& registry, Config cfg)
        : registry_(registry), cfg_(std::move(cfg)) {}

    ModelRegistry& registry_;
    Config cfg_;

    uWS::Loop* loop_ = nullptr;
    struct us_listen_socket_t* listen_socket_ = nullptr;

    // Touched only on the loop thread (open/close + deferred sends).
    std::set<WsConn*> live_clients_;

    std::atomic<int> active_sessions_{0};
    std::atomic<uint64_t> next_session_id_{1};

    void send_transcript(WsConn* ws, const std::string& text, int64_t t0, int64_t t1, bool is_final) {
        json j = {{"type", "transcript"}, {"text", text}, {"t0", t0}, {"t1", t1}, {"partial", !is_final}};
        std::string payload = j.dump();
        loop_->defer([this, ws, payload = std::move(payload)]() {
            if (live_clients_.count(ws)) ws->send(payload, uWS::OpCode::TEXT);
        });
    }

    // Create and start the session for a ready model. Runs on the loop thread.
    void start_session(WsConn* ws, uint64_t sid, DecodeScheduler* scheduler) {
        if (!live_clients_.count(ws)) return;  // client left while the model was loading
        if (!scheduler) {
            json err = {{"type", "error"}, {"message", "failed to load model"}};
            ws->send(err.dump(), uWS::OpCode::TEXT);
            ws->end(1011, "model load failed");
            return;
        }
        auto on_transcript = [this, ws](const std::string& text, int64_t t0, int64_t t1, bool is_final) {
            send_transcript(ws, text, t0, t1, is_final);
        };
        auto* psd = ws->getUserData();
        // Start with the client's VAD params if it sent them while the model was
        // loading, else the server defaults.
        ServerVadParams init_vad = psd->vad_set ? psd->vad : cfg_.vad;
        psd->session = std::make_shared<ParakeetSession>(
            sid, *scheduler, cfg_.vad_model_path, init_vad, std::move(on_transcript));
        if (!psd->session->start()) {
            LOG_ERROR("session " + std::to_string(sid) + ": failed to start (VAD load error)");
            psd->session.reset();
            json err = {{"type", "error"}, {"message", "failed to initialize ASR session"}};
            ws->send(err.dump(), uWS::OpCode::TEXT);
            ws->end(1011, "session init failed");
            return;
        }
        LOG_INFO("session " + std::to_string(sid) + " ready (model=" + psd->model_id +
                 ", active=" + std::to_string(active_sessions_.load()) + ")");
    }

    void on_open(WsConn* ws) {
        uint64_t sid = next_session_id_.fetch_add(1);
        live_clients_.insert(ws);
        active_sessions_.fetch_add(1);

        const std::string model_id = ws->getUserData()->model_id;
        LOG_INFO("session " + std::to_string(sid) + " connected (model=" + model_id +
                 ", loading…, active=" + std::to_string(active_sessions_.load()) + ")");

        // Resolve (and lazily load) the model off the loop thread, then marshal
        // session creation back onto the loop. Audio that arrives before the
        // session exists is dropped by on_message's null-session guard.
        registry_.get_or_load(model_id, [this, ws, sid](ParakeetModel*, DecodeScheduler* scheduler) {
            loop_->defer([this, ws, sid, scheduler]() { start_session(ws, sid, scheduler); });
        });
    }

    void on_message(WsConn* ws, std::string_view msg, uWS::OpCode op) {
        auto* psd = ws->getUserData();
        if (op == uWS::OpCode::BINARY) {
            if (!psd->session || msg.size() < 2) return;
            size_t n = msg.size() / 2;
            std::vector<float> f(n);
            const char* p = msg.data();
            for (size_t i = 0; i < n; ++i) {
                int16_t s;
                std::memcpy(&s, p + i * 2, sizeof(s));
                f[i] = static_cast<float>(s) / 32768.0f;
            }
            psd->session->feed_audio(f.data(), n);
        } else {  // TEXT: JSON control
            try {
                json m = json::parse(msg);
                std::string type = m.value("type", "");
                // "start"/"stop"/"set_language" accepted; session auto-runs, so these are advisory in v1.
                if (type == "stop" && psd->session) {
                    psd->session->stop();
                } else if (type == "set_vad") {
                    // Per-client VAD tuning. Defaults fill any field the client omits.
                    ServerVadParams p = cfg_.vad;
                    if (m.contains("data") && m["data"].is_object()) {
                        const auto& d = m["data"];
                        p.threshold = d.value("threshold", p.threshold);
                        p.min_silence = d.value("min_silence", p.min_silence);
                        p.min_speech = d.value("min_speech", p.min_speech);
                        p.max_speech = d.value("max_speech", p.max_speech);
                        p.partial_interval = d.value("partial_interval", p.partial_interval);
                    }
                    psd->vad = p;
                    psd->vad_set = true;
                    LOG_INFO("set_vad (threshold=" + std::to_string(p.threshold) +
                             ", min_silence=" + std::to_string(p.min_silence) + ")");
                    if (psd->session) psd->session->set_vad_params(p);  // else applied at session start
                }
            } catch (const json::exception&) {
                // ignore malformed control frames
            }
        }
    }

    void on_close(WsConn* ws) {
        live_clients_.erase(ws);
        int remaining = active_sessions_.fetch_sub(1) - 1;
        auto* psd = ws->getUserData();
        if (psd->session) {
            psd->session->stop();
            psd->session.reset();
        }
        LOG_INFO("session disconnected (active=" + std::to_string(remaining) + ")");
    }

    bool authorize(std::string_view auth_header) const {
        if (cfg_.api_key.empty()) return true;
        std::string expected = "Bearer " + cfg_.api_key;
        return auth_header == expected;
    }

    std::string models_json() const {
        json arr = json::array();
        for (const auto& m : registry_.list()) arr.push_back({{"id", m.id}, {"type", m.type}});
        return json{{"models", arr}}.dump();
    }

    std::string metrics_text() const {
        std::string b;
        b += "parakeet_active_sessions " + std::to_string(active_sessions_.load()) + "\n";
        b += "parakeet_loaded_models " + std::to_string(registry_.loaded_count()) + "\n";
        b += "parakeet_total_decoded " + std::to_string(registry_.total_decoded()) + "\n";
        b += "parakeet_total_batches " + std::to_string(registry_.total_batches()) + "\n";
        b += "parakeet_pending " + std::to_string(registry_.pending()) + "\n";
        return b;
    }

    void run() {
        auto app = uWS::App();

        app.get("/healthz", [](auto* res, auto* /*req*/) {
            res->writeHeader("Content-Type", "text/plain")->end("ok");
        });
        app.get("/models", [this](auto* res, auto* /*req*/) {
            res->writeHeader("Content-Type", "application/json")->end(models_json());
        });
        app.get("/metrics", [this](auto* res, auto* /*req*/) {
            res->writeHeader("Content-Type", "text/plain")->end(metrics_text());
        });

        app.ws<PerSocketData>("/*", {
            .compression = uWS::DISABLED,
            .maxPayloadLength = 1 * 1024 * 1024,
            .idleTimeout = 120,
            .upgrade = [this](auto* res, auto* req, auto* context) {
                if (!authorize(req->getHeader("authorization"))) {
                    res->writeStatus("401 Unauthorized")->end("unauthorized");
                    return;
                }
                if (active_sessions_.load() >= cfg_.max_sessions) {
                    res->writeStatus("503 Service Unavailable")->end("server at capacity");
                    return;
                }
                std::string model_id(req->getQuery("model"));
                if (model_id.empty()) model_id = registry_.default_id();
                if (model_id.empty() || !registry_.has(model_id)) {
                    res->writeStatus("404 Not Found")->end("unknown or unspecified model");
                    return;
                }
                res->template upgrade<PerSocketData>(
                    PerSocketData{std::move(model_id), nullptr},
                    req->getHeader("sec-websocket-key"),
                    req->getHeader("sec-websocket-protocol"),
                    req->getHeader("sec-websocket-extensions"),
                    context);
            },
            .open = [this](auto* ws) { on_open(ws); },
            .message = [this](auto* ws, std::string_view msg, uWS::OpCode op) { on_message(ws, msg, op); },
            .close = [this](auto* ws, int /*code*/, std::string_view /*msg*/) { on_close(ws); },
        });

        app.listen(cfg_.port, [this](auto* token) {
            listen_socket_ = token;
            if (token) LOG_INFO("Parakeet server listening on port " + std::to_string(cfg_.port));
            else LOG_ERROR("Failed to listen on port " + std::to_string(cfg_.port));
        });

        loop_ = uWS::Loop::get();
        app.run();
    }

    void stop() {
        if (loop_ && listen_socket_) {
            loop_->defer([this]() {
                us_listen_socket_close(0, listen_socket_);
                listen_socket_ = nullptr;
            });
        }
    }
};

ParakeetWsServer::ParakeetWsServer(ModelRegistry& registry, Config cfg)
    : impl_(std::make_unique<Impl>(registry, std::move(cfg))) {}

ParakeetWsServer::~ParakeetWsServer() = default;

void ParakeetWsServer::run() { impl_->run(); }
void ParakeetWsServer::stop() { impl_->stop(); }

} // namespace ais
