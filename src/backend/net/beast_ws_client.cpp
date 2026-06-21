// Boost.Beast-backed WebSocket client. The entire Boost dependency is confined
// to this translation unit; everything else depends only on ws_client.h.
//
// Design: one I/O thread runs a single io_context, so every async completion
// handler executes on that thread — an implicit strand, no locking needed for
// per-connection state. send_*() (called from other threads) marshals work onto
// the I/O thread via net::post. Reconnect uses exponential backoff. Keepalive
// relies on Beast's built-in keep_alive_pings (idle timeout) rather than manual
// pings, which would otherwise risk overlapping with an in-flight async_write.
#include "net/ws_client.h"
#include "core/logger.h"

#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/beast/ssl.hpp>
#include <boost/beast/websocket/ssl.hpp>
#include <boost/asio/connect.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/ssl.hpp>
#include <boost/asio/ssl/host_name_verification.hpp>
#include <boost/asio/steady_timer.hpp>
#include <boost/asio/executor_work_guard.hpp>
#include <openssl/ssl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

namespace ais::net {
namespace beast = boost::beast;
namespace websocket = beast::websocket;
namespace asio = boost::asio;
namespace ssl = boost::asio::ssl;
using tcp = asio::ip::tcp;

namespace {

constexpr size_t kMaxSendQueue = 256;  // soft cap; excess binary (audio) frames are dropped

struct ParsedUrl {
    bool tls = false;
    std::string host;
    std::string port;
    std::string target = "/";
};

bool parse_ws_url(const std::string& url, ParsedUrl& out) {
    auto sep = url.find("://");
    if (sep == std::string::npos) return false;
    std::string scheme = url.substr(0, sep);
    if (scheme == "wss") out.tls = true;
    else if (scheme == "ws") out.tls = false;
    else return false;

    std::string rest = url.substr(sep + 3);
    auto slash = rest.find('/');
    std::string hostport = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    out.target = (slash == std::string::npos) ? "/" : rest.substr(slash);
    if (out.target.empty()) out.target = "/";

    auto colon = hostport.rfind(':');
    if (colon != std::string::npos) {
        out.host = hostport.substr(0, colon);
        out.port = hostport.substr(colon + 1);
    } else {
        out.host = hostport;
        out.port = out.tls ? "443" : "80";
    }
    return !out.host.empty() && !out.port.empty();
}

template <bool kTls>
using ws_stream_t = std::conditional_t<
    kTls,
    websocket::stream<beast::ssl_stream<beast::tcp_stream>>,
    websocket::stream<beast::tcp_stream>>;

// Type-erased handle so BeastWsClient can drive either stream variant.
struct SessionBase {
    virtual ~SessionBase() = default;
    virtual void run() = 0;
    virtual void post_send(std::vector<uint8_t> data, bool binary) = 0;
    virtual void post_close() = 0;
};

// Owns one connection's full async lifecycle. Kept alive by shared_ptr captured
// in each outstanding async operation.
template <bool kTls>
class Session : public SessionBase, public std::enable_shared_from_this<Session<kTls>> {
public:
    using OnMessage = WsClient::MessageHandler;
    using OnState   = std::function<void(WsState, const std::string&)>;
    using OnEnded   = std::function<void()>;

    Session(asio::io_context& ioc, ssl::context* ctx,
            std::string host, std::string port, std::string target,
            std::map<std::string, std::string> headers, bool verify,
            int connect_timeout_ms,
            OnMessage on_msg, OnState on_state, OnEnded on_ended)
        : resolver_(ioc),
          ws_(make_ws(ioc, ctx)),
          host_(std::move(host)), port_(std::move(port)), target_(std::move(target)),
          headers_(std::move(headers)), verify_(verify),
          connect_timeout_ms_(connect_timeout_ms),
          on_msg_(std::move(on_msg)), on_state_(std::move(on_state)),
          on_ended_(std::move(on_ended)) {}

    void run() override {
        resolver_.async_resolve(
            host_, port_,
            beast::bind_front_handler(&Session::on_resolve, this->shared_from_this()));
    }

    void post_send(std::vector<uint8_t> data, bool binary) override {
        auto self = this->shared_from_this();
        asio::post(ws_.get_executor(),
                   [self, d = std::move(data), binary]() mutable {
                       if (binary && self->send_q_.size() >= kMaxSendQueue) return;  // drop audio under backpressure
                       self->send_q_.push_back({std::move(d), binary});
                       if (!self->writing_ && self->open_) self->do_write();
                   });
    }

    void post_close() override {
        auto self = this->shared_from_this();
        asio::post(ws_.get_executor(), [self] { self->do_close(); });
    }

private:
    static ws_stream_t<kTls> make_ws(asio::io_context& ioc, ssl::context* ctx) {
        if constexpr (kTls) return ws_stream_t<true>(ioc, *ctx);
        else { (void)ctx; return ws_stream_t<false>(ioc); }
    }

    void on_resolve(beast::error_code ec, tcp::resolver::results_type results) {
        if (ec) return fail(ec, "resolve");
        beast::get_lowest_layer(ws_).expires_after(std::chrono::milliseconds(connect_timeout_ms_));
        beast::get_lowest_layer(ws_).async_connect(
            results, beast::bind_front_handler(&Session::on_connect, this->shared_from_this()));
    }

    void on_connect(beast::error_code ec, tcp::resolver::results_type::endpoint_type) {
        if (ec) return fail(ec, "connect");
        if constexpr (kTls) {
            // SNI is best-effort: if it fails the TLS handshake/verification will
            // surface a real error code below, so warn and continue rather than
            // fabricating one here.
            if (!SSL_set_tlsext_host_name(ws_.next_layer().native_handle(), host_.c_str())) {
                LOG_WARN("[ws] failed to set TLS SNI hostname for " + host_);
            }
            if (verify_) {
                ws_.next_layer().set_verify_callback(ssl::host_name_verification(host_));
            }
            beast::get_lowest_layer(ws_).expires_after(std::chrono::milliseconds(connect_timeout_ms_));
            ws_.next_layer().async_handshake(
                ssl::stream_base::client,
                beast::bind_front_handler(&Session::on_ssl_handshake, this->shared_from_this()));
        } else {
            do_ws_handshake();
        }
    }

    void on_ssl_handshake(beast::error_code ec) {
        if (ec) return fail(ec, "tls_handshake");
        do_ws_handshake();
    }

    void do_ws_handshake() {
        // Hand timeout management over to the websocket layer (with keepalive pings).
        beast::get_lowest_layer(ws_).expires_never();
        auto opt = websocket::stream_base::timeout::suggested(beast::role_type::client);
        opt.keep_alive_pings = true;
        ws_.set_option(opt);
        ws_.set_option(websocket::stream_base::decorator(
            [h = headers_](websocket::request_type& req) {
                for (const auto& [k, v] : h) req.set(k, v);
            }));
        ws_.async_handshake(host_, target_,
                            beast::bind_front_handler(&Session::on_handshake, this->shared_from_this()));
    }

    void on_handshake(beast::error_code ec) {
        if (ec) return fail(ec, "ws_handshake");
        open_ = true;
        on_state_(WsState::Open, "");
        do_read();
        if (!send_q_.empty() && !writing_) do_write();
    }

    void do_read() {
        ws_.async_read(buffer_,
                       beast::bind_front_handler(&Session::on_read, this->shared_from_this()));
    }

    void on_read(beast::error_code ec, std::size_t) {
        if (ec == websocket::error::closed) return fail(ec, "closed", true);
        if (ec) return fail(ec, "read");
        const bool is_binary = ws_.got_binary();
        std::string payload = beast::buffers_to_string(buffer_.data());
        buffer_.consume(buffer_.size());
        if (on_msg_) on_msg_(reinterpret_cast<const uint8_t*>(payload.data()), payload.size(), is_binary);
        do_read();
    }

    void do_write() {
        writing_ = true;
        ws_.binary(send_q_.front().second);
        ws_.async_write(asio::buffer(send_q_.front().first),
                        beast::bind_front_handler(&Session::on_write, this->shared_from_this()));
    }

    void on_write(beast::error_code ec, std::size_t) {
        if (ec) return fail(ec, "write");
        send_q_.pop_front();
        if (send_q_.empty()) writing_ = false;
        else do_write();
    }

    void do_close() {
        if (closing_) return;
        closing_ = true;
        if (open_) {
            ws_.async_close(websocket::close_code::normal,
                            [self = this->shared_from_this()](beast::error_code) {});
        }
    }

    void fail(beast::error_code ec, const char* what, bool graceful = false) {
        if (ended_) return;
        ended_ = true;
        open_ = false;
        // A cancelled read/write during our own close() is a normal shutdown, not an error.
        const bool quiet = graceful || closing_ || ec == asio::error::operation_aborted;
        const std::string detail = std::string(what) + ": " + ec.message();
        if (!quiet) LOG_WARN(std::string("[ws] ") + detail);
        on_state_(quiet ? WsState::Closed : WsState::Error, detail);
        beast::error_code ig;
        beast::get_lowest_layer(ws_).socket().close(ig);
        on_ended_();
    }

    tcp::resolver resolver_;
    ws_stream_t<kTls> ws_;
    beast::flat_buffer buffer_;

    std::string host_, port_, target_;
    std::map<std::string, std::string> headers_;
    bool verify_;
    int connect_timeout_ms_;

    OnMessage on_msg_;
    OnState on_state_;
    OnEnded on_ended_;

    std::deque<std::pair<std::vector<uint8_t>, bool>> send_q_;
    bool writing_ = false;
    bool open_ = false;
    bool closing_ = false;
    bool ended_ = false;
};

class BeastWsClient final : public WsClient {
public:
    explicit BeastWsClient(const WsClientConfig& cfg)
        : cfg_(cfg), ssl_ctx_(ssl::context::tlsv12_client),
          reconnect_timer_(ioc_), backoff_ms_(cfg.reconnect_min_ms) {
        parsed_ok_ = parse_ws_url(cfg_.url, url_);
    }

    ~BeastWsClient() override { stop(); }

    void set_on_message(MessageHandler h) override { on_message_ = std::move(h); }
    void set_on_state(StateHandler h) override { on_state_ = std::move(h); }

    void start() override {
        if (running_.exchange(true)) return;
        if (!parsed_ok_) {
            running_ = false;
            LOG_ERROR("[ws] invalid URL: " + cfg_.url);
            if (on_state_) on_state_(WsState::Error, "invalid url");
            return;
        }
        configure_tls();
        work_guard_.emplace(ioc_.get_executor());
        io_thread_ = std::thread([this] {
            asio::post(ioc_, [this] { start_connect(); });
            ioc_.run();
        });
    }

    void stop() override {
        if (!running_.exchange(false)) {
            if (io_thread_.joinable()) io_thread_.join();
            return;
        }
        asio::post(ioc_, [this] {
            reconnect_timer_.cancel();
            std::shared_ptr<SessionBase> s;
            { std::lock_guard<std::mutex> lk(session_mtx_); s = session_; }
            if (s) s->post_close();
            if (work_guard_) work_guard_.reset();
        });
        if (io_thread_.joinable()) io_thread_.join();
        open_ = false;
    }

    bool send_binary(const uint8_t* data, size_t len) override {
        return enqueue(std::vector<uint8_t>(data, data + len), true);
    }

    bool send_text(const std::string& text) override {
        return enqueue(std::vector<uint8_t>(text.begin(), text.end()), false);
    }

    bool is_open() const override { return open_.load(); }

private:
    bool enqueue(std::vector<uint8_t> data, bool binary) {
        if (!running_) return false;
        std::shared_ptr<SessionBase> s;
        { std::lock_guard<std::mutex> lk(session_mtx_); s = session_; }
        if (!s) return false;  // not connected yet — drop (live audio cannot be sent pre-connect)
        s->post_send(std::move(data), binary);
        return true;
    }

    void configure_tls() {
        if (!url_.tls) return;
        if (cfg_.verify_tls) {
            ssl_ctx_.set_verify_mode(ssl::verify_peer);
            beast::error_code ec;
            if (!cfg_.ca_file.empty()) ssl_ctx_.load_verify_file(cfg_.ca_file, ec);
            else ssl_ctx_.set_default_verify_paths(ec);  // honors SSL_CERT_FILE / SSL_CERT_DIR
            if (ec) LOG_WARN("[ws] TLS verify setup: " + ec.message());
        } else {
            ssl_ctx_.set_verify_mode(ssl::verify_none);
        }
    }

    void emit_state(WsState st, const std::string& detail) {
        if (st == WsState::Open) { open_ = true; backoff_ms_ = cfg_.reconnect_min_ms; }
        else open_ = false;
        if (on_state_) on_state_(st, detail);
    }

    void start_connect() {
        if (!running_) return;
        emit_state(WsState::Connecting, cfg_.url);
        auto on_state = [this](WsState st, const std::string& d) { emit_state(st, d); };
        auto on_ended = [this] { asio::post(ioc_, [this] { handle_ended(); }); };

        std::shared_ptr<SessionBase> s;
        if (url_.tls) {
            s = std::make_shared<Session<true>>(ioc_, &ssl_ctx_, url_.host, url_.port, url_.target,
                                                cfg_.headers, cfg_.verify_tls, cfg_.connect_timeout_ms,
                                                on_message_, on_state, on_ended);
        } else {
            s = std::make_shared<Session<false>>(ioc_, nullptr, url_.host, url_.port, url_.target,
                                                 cfg_.headers, cfg_.verify_tls, cfg_.connect_timeout_ms,
                                                 on_message_, on_state, on_ended);
        }
        { std::lock_guard<std::mutex> lk(session_mtx_); session_ = s; }
        s->run();
    }

    void handle_ended() {
        { std::lock_guard<std::mutex> lk(session_mtx_); session_.reset(); }
        if (!running_ || !cfg_.auto_reconnect) return;
        reconnect_timer_.expires_after(std::chrono::milliseconds(backoff_ms_));
        reconnect_timer_.async_wait([this](beast::error_code ec) {
            if (!ec && running_) start_connect();
        });
        backoff_ms_ = std::min(backoff_ms_ * 2, cfg_.reconnect_max_ms);
    }

    WsClientConfig cfg_;
    ParsedUrl url_;
    bool parsed_ok_ = false;

    asio::io_context ioc_;
    ssl::context ssl_ctx_;
    std::optional<asio::executor_work_guard<asio::io_context::executor_type>> work_guard_;
    asio::steady_timer reconnect_timer_;
    int backoff_ms_;

    std::thread io_thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> open_{false};

    MessageHandler on_message_;
    StateHandler on_state_;

    std::mutex session_mtx_;
    std::shared_ptr<SessionBase> session_;
};

} // namespace

std::unique_ptr<WsClient> make_ws_client(const WsClientConfig& config) {
    return std::make_unique<BeastWsClient>(config);
}

} // namespace ais::net
