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

        // Exclusive, because uSockets otherwise sets SO_REUSEPORT and two
        // backends bind the same port happily — the kernel then hands the app's
        // connection to whichever it likes. A stale process that survived a
        // restart could take that connection and answer nothing, which looks
        // exactly like a model that never loaded. Binding exclusively turns that
        // silent misrouting into a failure this process reports and exits on.
        app.listen(port_, LIBUS_LISTEN_EXCLUSIVE_PORT, [this](auto* token) {
            listen_socket_ = token;
            if (token) {
                LOG_INFO("WebSocket server listening on port " + std::to_string(port_));
            } else {
                LOG_ERROR("Failed to listen on port " + std::to_string(port_));
            }
        });

        // Without a listen socket the loop has nothing to close, so stop() would
        // have nothing to defer and its join() would wait on a run() that never
        // returns. Never enter the loop we could not get out of.
        if (!listen_socket_) {
            if (listen_failed_handler_) listen_failed_handler_();
            return;
        }

        {
            std::lock_guard<std::mutex> lock(loop_mutex_);
            // A stop that ran before this assignment found no loop to defer the
            // close onto and went straight to join(). Entering the event loop now
            // would make that join permanent — the flag it left behind is the
            // only trace of it, so it has to be read before committing.
            if (stopped_) {
                if (listen_socket_) {
                    us_listen_socket_close(0, listen_socket_);
                    listen_socket_ = nullptr;
                }
                return;
            }
            loop_ = uWS::Loop::get();
        }
        app.run();
    });
}

void WsServer::stop() {
    {
        std::lock_guard<std::mutex> lock(loop_mutex_);
        stopped_ = true;
        if (loop_) {
            loop_->defer([this]() {
                if (listen_socket_) {
                    us_listen_socket_close(0, listen_socket_);
                    listen_socket_ = nullptr;
                }
                // Closing the listening socket only stops new connections. An
                // open one keeps the event loop alive by itself, so app.run()
                // would never return and the join() below would be permanent —
                // which is what a restart looked like whenever the app's own
                // socket had not finished closing before the process was killed.
                std::vector<uWS::WebSocket<false, true, WsPerSocketData>*> open;
                {
                    std::lock_guard<std::mutex> lock(clients_mutex_);
                    open = clients_;
                }
                // Copied out first: close() runs the .close handler inline, and
                // that handler takes clients_mutex_ to erase its own entry.
                for (auto* ws : open) ws->close();
            });
        }
        loop_ = nullptr;
    }
    if (server_thread_.joinable()) {
        server_thread_.join();
    }
}

void WsServer::broadcast(const json& message) {
    std::string payload = message.dump();

    std::lock_guard<std::mutex> lock(loop_mutex_);
    if (stopped_ || !loop_) return;
    loop_->defer([this, payload]() {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        for (auto* ws : clients_) {
            ws->send(payload, uWS::OpCode::TEXT);
        }
    });
}

void WsServer::on_listen_failed(std::function<void()> handler) {
    listen_failed_handler_ = std::move(handler);
}

void WsServer::on_command(const std::string& type, CommandHandler handler) {
    std::lock_guard<std::mutex> lock(handlers_mutex_);
    handlers_[type] = std::move(handler);
}

} // namespace ais
