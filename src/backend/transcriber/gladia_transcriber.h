#pragma once
#include "transcriber/transcriber.h"
#include <openssl/ssl.h>
#include <atomic>
#include <cstdint>
#include <condition_variable>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>

namespace ais {

class GladiaTranscriber : public ITranscriber {
public:
    explicit GladiaTranscriber(std::string api_key,
                               std::string model       = "solaria-1",
                               std::string extra_config = "");
    ~GladiaTranscriber() override;

    bool load_model(const std::string& path) override;
    void set_language(const std::string& lang) override;
    void set_translate(bool) override {}
    void feed_audio(const float* samples, size_t count) override;
    std::vector<TranscriptSegment> process() override;
    bool is_model_loaded() const override { return connected_.load(); }

private:
    struct WsFrame { uint8_t opcode; std::vector<uint8_t> payload; };
    struct ParsedUrl { std::string host; int port = 443; std::string path; };

    void io_thread_func();
    bool init_session(std::string& ws_url);
    bool tls_connect(const std::string& host, int port);
    bool connect_websocket(const std::string& ws_url);
    void io_loop();
    void close_session();
    void disconnect_and_cleanup();

    bool ws_send_binary(const uint8_t* data, size_t len);
    bool ws_read_frame(WsFrame& frame);
    bool ssl_write_all(const uint8_t* buf, size_t len);
    bool ssl_read_exact(uint8_t* buf, size_t len);

    static bool parse_wss_url(const std::string& url, ParsedUrl& out);
    void handle_ws_frame(const WsFrame& frame);
    void handle_text_frame(const std::string& json_str);
    std::string build_init_body() const;

    std::string api_key_;
    std::string model_ = "solaria-1";
    std::string extra_config_;

    mutable std::mutex lang_mutex_;
    std::string language_ = "auto";

    SSL_CTX* ssl_ctx_ = nullptr;
    SSL*     ssl_     = nullptr;
    std::atomic<intptr_t> sock_fd_{-1};

    std::atomic<bool> should_run_{false};
    std::atomic<bool> connected_{false};
    std::atomic<bool> reconnect_requested_{false};
    std::atomic<bool> rate_limited_{false};

    std::queue<std::vector<int16_t>> audio_queue_;
    std::mutex audio_mutex_;
    std::condition_variable audio_cv_;

    std::queue<TranscriptSegment> result_queue_;
    std::mutex result_mutex_;

    std::thread io_thread_;

    static constexpr size_t MAX_AUDIO_QUEUE = 50;
    static constexpr int    SAMPLE_RATE     = 16000;
};

} // namespace ais
