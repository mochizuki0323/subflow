#pragma once
// Thin client transcriber that streams audio to a remote subflow-parakeet-server
// and receives transcripts back. All WebSocket plumbing (ws:// or wss://,
// reconnect, framing) is delegated to net::WsClient (Boost.Beast); this class
// only does float→int16 conversion and JSON transcript parsing.
#include "transcriber/transcriber.h"
#include "net/ws_client.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace ais {

class RemoteParakeetTranscriber : public ITranscriber {
public:
    RemoteParakeetTranscriber(std::string url, std::string api_key);
    ~RemoteParakeetTranscriber() override;

    bool load_model(const std::string& path) override;  // path ignored; connects to the server
    void set_language(const std::string& lang) override;
    void set_translate(bool) override {}
    void feed_audio(const float* samples, size_t count) override;
    std::vector<TranscriptSegment> process() override;
    bool is_model_loaded() const override { return connected_.load(); }

private:
    void on_message(const uint8_t* data, size_t len, bool is_binary);
    void on_state(net::WsState state, const std::string& detail);

    std::string url_;
    std::string api_key_;
    std::string language_ = "auto";

    std::unique_ptr<net::WsClient> ws_;
    std::atomic<bool> connected_{false};

    std::mutex result_mutex_;
    std::vector<TranscriptSegment> result_queue_;

    static constexpr int kSampleRate = 16000;
};

} // namespace ais
