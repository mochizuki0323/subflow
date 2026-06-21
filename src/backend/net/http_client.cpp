// Synchronous HTTP(S) client backed by Boost.Beast. The entire Boost dependency
// is confined to this translation unit.
#include "net/http_client.h"

#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/ssl.hpp>
#include <boost/asio/connect.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/ssl.hpp>
#include <boost/asio/ssl/host_name_verification.hpp>
#include <openssl/ssl.h>

#include <chrono>
#include <exception>
#include <string>

namespace ais::net {
namespace beast = boost::beast;
namespace http = beast::http;
namespace asio = boost::asio;
namespace ssl = boost::asio::ssl;
using tcp = asio::ip::tcp;

namespace {

struct Url {
    bool tls = false;
    std::string host, port, target = "/";
};

bool parse_http_url(const std::string& url, Url& out) {
    auto sep = url.find("://");
    if (sep == std::string::npos) return false;
    std::string scheme = url.substr(0, sep);
    if (scheme == "https") out.tls = true;
    else if (scheme == "http") out.tls = false;
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

http::verb to_verb(const std::string& m) {
    if (m == "POST") return http::verb::post;
    if (m == "PUT") return http::verb::put;
    if (m == "DELETE") return http::verb::delete_;
    return http::verb::get;
}

http::request<http::string_body> build_request(const HttpRequest& in, const Url& u) {
    http::request<http::string_body> req{to_verb(in.method), u.target, 11};
    req.set(http::field::host, u.host);
    req.set(http::field::user_agent, "subflow");
    for (const auto& [k, v] : in.headers) req.set(k, v);
    if (!in.body.empty()) req.body() = in.body;
    req.prepare_payload();
    return req;
}

} // namespace

HttpResponse http_request(const HttpRequest& in) {
    HttpResponse out;
    Url u;
    if (!parse_http_url(in.url, u)) {
        out.error = "invalid url: " + in.url;
        return out;
    }

    try {
        asio::io_context ioc;
        tcp::resolver resolver(ioc);
        auto const results = resolver.resolve(u.host, u.port);
        auto req = build_request(in, u);

        beast::flat_buffer buffer;
        http::response<http::string_body> res;

        if (u.tls) {
            ssl::context ctx(ssl::context::tlsv12_client);
            if (in.verify_tls) {
                ctx.set_verify_mode(ssl::verify_peer);
                beast::error_code vec;
                if (!in.ca_file.empty()) ctx.load_verify_file(in.ca_file, vec);
                else ctx.set_default_verify_paths(vec);
            } else {
                ctx.set_verify_mode(ssl::verify_none);
            }
            beast::ssl_stream<beast::tcp_stream> stream(ioc, ctx);
            if (!SSL_set_tlsext_host_name(stream.native_handle(), u.host.c_str())) {
                out.error = "failed to set TLS SNI hostname";
                return out;
            }
            if (in.verify_tls) stream.set_verify_callback(ssl::host_name_verification(u.host));
            beast::get_lowest_layer(stream).expires_after(std::chrono::milliseconds(in.timeout_ms));
            beast::get_lowest_layer(stream).connect(results);
            stream.handshake(ssl::stream_base::client);
            http::write(stream, req);
            http::read(stream, buffer, res);
            beast::error_code ig;
            stream.shutdown(ig);
        } else {
            beast::tcp_stream stream(ioc);
            stream.expires_after(std::chrono::milliseconds(in.timeout_ms));
            stream.connect(results);
            http::write(stream, req);
            http::read(stream, buffer, res);
            beast::error_code ig;
            stream.socket().shutdown(tcp::socket::shutdown_both, ig);
        }

        out.ok = true;
        out.status = res.result_int();
        out.body = res.body();
    } catch (const std::exception& e) {
        out.error = e.what();
    }
    return out;
}

} // namespace ais::net
