#pragma once
#include <App.h>
#include <json.hpp>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ais {

using json = nlohmann::json;

struct WsPerSocketData {};

class WsServer {
public:
    explicit WsServer(int port = 9876);
    ~WsServer();

    void start();
    void stop();

    void broadcast(const json& message);

    using CommandHandler = std::function<void(const json&)>;
    void on_command(const std::string& type, CommandHandler handler);

    /**
     * Called from the server thread when the port could not be bound. A backend
     * that cannot listen is unreachable and unstoppable from the app's side, so
     * the owner is told to shut down rather than sit there: exiting lets the
     * supervisor try again once whoever holds the port has let go.
     */
    void on_listen_failed(std::function<void()> handler);

private:
    int port_;
    std::thread server_thread_;
    struct us_listen_socket_t* listen_socket_ = nullptr;

    // loop_ lives in the server thread (freed when that thread exits); guard it
    // and refuse broadcasts once stop() has begun so no defer() hits a dead loop.
    std::mutex loop_mutex_;
    uWS::Loop* loop_ = nullptr;
    bool stopped_ = false;

    std::function<void()> listen_failed_handler_;

    std::mutex handlers_mutex_;
    std::map<std::string, CommandHandler> handlers_;

    std::mutex clients_mutex_;
    std::vector<uWS::WebSocket<false, true, WsPerSocketData>*> clients_;
};

} // namespace ais
