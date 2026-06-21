#pragma once
#include "transcriber/transcriber.h"
#include "net/ws_client.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <queue>
#include <string>

namespace ais {

class DeepgramTranscriber : public ITranscriber {
public:
    explicit DeepgramTranscriber(std::string api_key,
                                 std::string model       = "nova-3",
                                 std::string extra_params = "");
    ~DeepgramTranscriber() override;

    // path is ignored; connects to Deepgram cloud.
    bool load_model(const std::string& path) override;

    void set_language(const std::string& lang) override;
    void set_translate(bool) override {}

    void feed_audio(const float* samples, size_t count) override;
    std::vector<TranscriptSegment> process() override;

    bool is_model_loaded() const override { return connected_.load(); }

private:
    void connect();                      // (re)build the URL and (re)connect
    std::string build_ws_url() const;    // full wss:// URL incl. query params
    void on_message(const uint8_t* data, size_t len, bool is_binary);
    void on_state(net::WsState state, const std::string& detail);
    void handle_text_frame(const std::string& json_str);

    std::string api_key_;
    std::string model_        = "nova-3";
    std::string extra_params_;

    mutable std::mutex lang_mutex_;
    std::string language_ = "en";

    std::atomic<bool> running_{false};
    std::atomic<bool> connected_{false};

    std::mutex ws_mutex_;
    std::unique_ptr<net::WsClient> ws_;

    std::queue<TranscriptSegment> result_queue_;
    std::mutex result_mutex_;

    static constexpr int SAMPLE_RATE = 16000;
};

} // namespace ais
