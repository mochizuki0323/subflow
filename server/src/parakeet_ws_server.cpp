#include "parakeet_ws_server.h"
#include "parakeet_model.h"
#include "decode_scheduler.h"
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
    std::shared_ptr<ParakeetSession> session;
};
using WsConn = uWS::WebSocket<false, true, PerSocketData>;
}  // namespace

struct ParakeetWsServer::Impl {
    Impl(ParakeetModel& model, DecodeScheduler& scheduler, Config cfg)
        : model_(model), scheduler_(scheduler), cfg_(std::move(cfg)) {}

    ParakeetModel& model_;
    DecodeScheduler& scheduler_;
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

    void on_open(WsConn* ws) {
        uint64_t sid = next_session_id_.fetch_add(1);
        live_clients_.insert(ws);
        active_sessions_.fetch_add(1);

        auto on_transcript = [this, ws](const std::string& text, int64_t t0, int64_t t1, bool is_final) {
            send_transcript(ws, text, t0, t1, is_final);
        };
        auto* psd = ws->getUserData();
        psd->session = std::make_shared<ParakeetSession>(
            sid, scheduler_, cfg_.vad_model_path, cfg_.vad, std::move(on_transcript));

        if (!psd->session->start()) {
            LOG_ERROR("session " + std::to_string(sid) + ": failed to start (VAD load error)");
            json err = {{"type", "error"}, {"message", "failed to initialize ASR session"}};
            ws->send(err.dump(), uWS::OpCode::TEXT);
            ws->end(1011, "session init failed");
            return;
        }
        LOG_INFO("session " + std::to_string(sid) + " connected (active=" +
                 std::to_string(active_sessions_.load()) + ")");
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
                if (type == "stop" && psd->session) psd->session->stop();
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

    std::string metrics_text() const {
        std::string b;
        b += "parakeet_active_sessions " + std::to_string(active_sessions_.load()) + "\n";
        b += "parakeet_total_decoded " + std::to_string(scheduler_.total_decoded()) + "\n";
        b += "parakeet_total_batches " + std::to_string(scheduler_.total_batches()) + "\n";
        b += "parakeet_pending " + std::to_string(scheduler_.pending()) + "\n";
        return b;
    }

    void run() {
        auto app = uWS::App();

        app.get("/healthz", [](auto* res, auto* /*req*/) {
            res->writeHeader("Content-Type", "text/plain")->end("ok");
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
                res->template upgrade<PerSocketData>(
                    PerSocketData{},
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

ParakeetWsServer::ParakeetWsServer(ParakeetModel& model, DecodeScheduler& scheduler, Config cfg)
    : impl_(std::make_unique<Impl>(model, scheduler, std::move(cfg))) {}

ParakeetWsServer::~ParakeetWsServer() = default;

void ParakeetWsServer::run() { impl_->run(); }
void ParakeetWsServer::stop() { impl_->stop(); }

} // namespace ais
