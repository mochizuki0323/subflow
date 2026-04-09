#include "core/logger.h"
#include "ipc/ws_server.h"

namespace ais {

WsServer::WsServer(int port) : port_(port) {}

WsServer::~WsServer() {
    stop();
}

void WsServer::start() {
    server_thread_ = std::thread([this]() {
        auto app = uWS::App();

        app.ws<WsPerSocketData>("/*", {
            .compression = uWS::DISABLED,
            .maxPayloadLength = 64 * 1024,
            .idleTimeout = 120,

            .open = [this](auto* ws) {
                std::lock_guard<std::mutex> lock(clients_mutex_);
                clients_.push_back(ws);
                LOG_INFO("WebSocket client connected");
            },

            .message = [this](auto* /*ws*/, std::string_view message, uWS::OpCode /*opCode*/) {
                try {
                    json msg = json::parse(message);
                    std::string type = msg.value("type", "");

                    std::lock_guard<std::mutex> lock(handlers_mutex_);
                    auto it = handlers_.find(type);
                    if (it != handlers_.end()) {
                        it->second(msg.value("data", json::object()));
                    } else {
                        LOG_WARN("Unknown command type: " + type);
                    }
                } catch (const json::exception& e) {
                    LOG_ERROR(std::string("JSON parse error: ") + e.what());
                }
            },

            .close = [this](auto* ws, int /*code*/, std::string_view /*message*/) {
                std::lock_guard<std::mutex> lock(clients_mutex_);
                clients_.erase(
                    std::remove(clients_.begin(), clients_.end(), ws),
                    clients_.end()
                );
                LOG_INFO("WebSocket client disconnected");
            }
        });

        app.listen(port_, [this](auto* token) {
            listen_socket_ = token;
            if (token) {
                LOG_INFO("WebSocket server listening on port " + std::to_string(port_));
            } else {
                LOG_ERROR("Failed to listen on port " + std::to_string(port_));
            }
        });

        loop_ = uWS::Loop::get();
        app.run();
    });
}

void WsServer::stop() {
    if (loop_ && listen_socket_) {
        loop_->defer([this]() {
            us_listen_socket_close(0, listen_socket_);
            listen_socket_ = nullptr;
        });
    }
    if (server_thread_.joinable()) {
        server_thread_.join();
    }
}

void WsServer::broadcast(const json& message) {
    if (!loop_) return;
    std::string payload = message.dump();

    loop_->defer([this, payload]() {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        for (auto* ws : clients_) {
            ws->send(payload, uWS::OpCode::TEXT);
        }
    });
}

void WsServer::on_command(const std::string& type, CommandHandler handler) {
    std::lock_guard<std::mutex> lock(handlers_mutex_);
    handlers_[type] = std::move(handler);
}

} // namespace ais
