#pragma once
// Minimal synchronous HTTP(S) client (Boost.Beast under the hood, confined to
// http_client.cpp). Used for one-shot request/response calls such as Gladia's
// POST /v2/live session creation. Boost-free interface.
#include <map>
#include <string>

namespace ais::net {

struct HttpRequest {
    std::string method = "GET";                   // GET | POST | PUT | DELETE
    std::string url;                              // http:// or https://
    std::map<std::string, std::string> headers;   // extra request headers
    std::string body;                             // request body (e.g. JSON)
    bool verify_tls = true;
    std::string ca_file;                          // optional CA bundle override
    int timeout_ms = 30000;
};

struct HttpResponse {
    bool ok = false;        // true if a response was received (any status)
    int status = 0;         // HTTP status code
    std::string body;
    std::string error;      // populated when ok == false
};

HttpResponse http_request(const HttpRequest& request);

} // namespace ais::net
