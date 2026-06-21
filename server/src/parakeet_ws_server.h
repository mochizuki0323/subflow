#pragma once
// Production WebSocket front door for the Parakeet inference server. Built on
// uWebSockets (already vendored). Each connection gets its own ParakeetSession;
// decoding is shared via a per-model DecodeScheduler + ParakeetModel resolved
// from the ModelRegistry. uWebSockets is confined to the .cpp via a pimpl so
// server_main and the rest of the tree stay free of <App.h>.
//
// Protocol:
//   client → server: binary frames = 16 kHz mono int16 PCM (little-endian);
//                     text frames  = JSON control ({"type":"start"|"stop"|...}).
//   server → client: text frames  = JSON {"type":"transcript","text","t0","t1","partial"}.
//   model select: optional "?model=<id>" query on the WS URL; falls back to the
//                 single registered model when omitted.
//   discovery: GET /models → JSON {"models":[{"id","type"},...]}.
//   auth: Authorization: Bearer <api-key> header checked at the WS upgrade.
#include "parakeet_session.h"  // ServerVadParams

#include <memory>
#include <string>

namespace ais {

class ModelRegistry;

class ParakeetWsServer {
public:
    struct Config {
        int port = 9090;
        std::string api_key;        // empty disables auth
        std::string vad_model_path;
        ServerVadParams vad;
        int max_sessions = 64;
    };

    ParakeetWsServer(ModelRegistry& registry, Config cfg);
    ~ParakeetWsServer();

    void run();   // blocking: listens and serves until stop()
    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace ais
