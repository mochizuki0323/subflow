#pragma once
#include "transcriber/transcriber.h"
#include "net/ws_client.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>

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
    // Gladia sessions are single-use (POST /v2/live yields a one-shot ws URL), so
    // a small manager thread re-POSTs to create a fresh session whenever the
    // WebSocket drops or the language changes. All TLS/HTTP/framing is delegated
    // to net::HttpClient / net::WsClient.
    void session_thread_func();
    bool init_session(std::string& ws_url);
    std::string build_init_body() const;
    void on_message(const uint8_t* data, size_t len, bool is_binary);
    void on_state(net::WsState state, const std::string& detail);
    void handle_text_frame(const std::string& json_str);

    std::string api_key_;
    std::string model_ = "solaria-1";
    std::string extra_config_;

    mutable std::mutex lang_mutex_;
    std::string language_ = "auto";

    std::atomic<bool> running_{false};
    std::atomic<bool> connected_{false};
    std::atomic<bool> reconnect_requested_{false};
    std::atomic<bool> rate_limited_{false};

    std::mutex state_mutex_;
    std::condition_variable state_cv_;
    bool closed_ = false;  // current session's ws has closed

    std::mutex ws_mutex_;
    std::unique_ptr<net::WsClient> ws_;

    std::queue<TranscriptSegment> result_queue_;
    std::mutex result_mutex_;

    std::thread session_thread_;

    static constexpr int SAMPLE_RATE = 16000;
};

} // namespace ais
