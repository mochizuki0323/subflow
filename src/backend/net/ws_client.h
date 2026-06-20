#pragma once
// Transport-agnostic WebSocket client interface. Deliberately free of any Boost
// headers so transcribers depend only on this thin surface; the Boost.Beast
// implementation lives entirely in beast_ws_client.cpp. Swapping the underlying
// library means touching one file.
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>

namespace ais::net {

enum class WsState { Connecting, Open, Closed, Error };

struct WsClientConfig {
    std::string url;                                  // ws:// or wss://
    std::map<std::string, std::string> headers;       // extra request headers (e.g. Authorization)
    bool auto_reconnect   = true;
    int  reconnect_min_ms = 500;                      // backoff floor
    int  reconnect_max_ms = 10000;                    // backoff ceiling
    int  ping_interval_ms = 20000;                    // keepalive ping; 0 disables
    int  connect_timeout_ms = 15000;
    bool verify_tls       = true;                     // verify server cert for wss://
    std::string ca_file;                              // optional CA bundle override (else system defaults)
};

// All callbacks are invoked on the client's internal I/O thread. Handlers must
// not block. send_*() may be called from any thread.
class WsClient {
public:
    using MessageHandler = std::function<void(const uint8_t* data, size_t len, bool is_binary)>;
    using StateHandler   = std::function<void(WsState state, const std::string& detail)>;

    virtual ~WsClient() = default;

    virtual void set_on_message(MessageHandler handler) = 0;
    virtual void set_on_state(StateHandler handler) = 0;

    virtual void start() = 0;   // begin connecting asynchronously (spawns I/O thread)
    virtual void stop() = 0;    // close connection and join I/O thread (idempotent)

    // Queue a frame for sending. Returns false only if the client is stopped.
    virtual bool send_binary(const uint8_t* data, size_t len) = 0;
    virtual bool send_text(const std::string& text) = 0;

    virtual bool is_open() const = 0;
};

std::unique_ptr<WsClient> make_ws_client(const WsClientConfig& config);

} // namespace ais::net
