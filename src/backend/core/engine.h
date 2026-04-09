#pragma once
#include "core/config.h"
#include "audio/audio_source.h"
#include "transcriber/transcriber.h"
#include "ipc/ws_server.h"
#include <atomic>
#include <memory>
#include <thread>

namespace ais {

class Engine {
public:
    explicit Engine(const Config& config);
    ~Engine();

    void run();   // Blocking: starts WS server and pipeline
    void stop();

private:
    void setup_command_handlers();
    void pipeline_loop();

    void send_source_list();
    void send_status();

    Config config_;
    std::unique_ptr<IAudioSource> audio_source_;
    std::unique_ptr<ITranscriber> transcriber_;
    WsServer ws_server_;

    std::thread pipeline_thread_;
    std::atomic<bool> running_{false};
    std::string current_state_ = "idle";
    uint32_t capture_source_id_ = 0;
    std::string capture_source_name_;
    std::atomic<float> audio_level_{0.0f};
};

} // namespace ais
