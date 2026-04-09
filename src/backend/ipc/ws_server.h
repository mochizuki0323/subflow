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

private:
    int port_;
    std::thread server_thread_;
    struct us_listen_socket_t* listen_socket_ = nullptr;
    uWS::Loop* loop_ = nullptr;

    std::mutex handlers_mutex_;
    std::map<std::string, CommandHandler> handlers_;

    std::mutex clients_mutex_;
    std::vector<uWS::WebSocket<false, true, WsPerSocketData>*> clients_;
};

} // namespace ais
