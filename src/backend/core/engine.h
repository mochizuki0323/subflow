#pragma once
#include "core/config.h"
#include "audio/audio_source.h"
#include "audio/denoiser.h"
#include "transcriber/transcriber.h"
#include "ipc/ws_server.h"
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

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

    // WS command handlers run on the uWS server thread; they only enqueue.
    // The pipeline thread drains the queue, so transcriber_/config_/denoiser_
    // and capture state are touched by a single thread.
    void enqueue_command(std::function<void()> command);
    void drain_commands();

    void send_source_list();
    void send_status();
    void apply_denoise_config(const std::string& model_path,
                              const std::string& architecture, bool enabled);

    Config config_;
    std::unique_ptr<IAudioSource> audio_source_;
    std::unique_ptr<ITranscriber> transcriber_;
    Denoiser denoiser_;
    WsServer ws_server_;

    std::thread pipeline_thread_;
    std::mutex command_mutex_;
    std::vector<std::function<void()>> pending_commands_;
    std::atomic<bool> running_{false};
    std::atomic<bool> denoise_active_{false};
    std::string current_state_ = "idle";
    uint32_t capture_source_id_ = 0;
    std::string capture_source_name_;
    std::atomic<float> audio_level_{0.0f};
};

} // namespace ais
