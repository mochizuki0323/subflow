#pragma once
// Thin client transcriber that streams audio to a remote subflow-parakeet-server
// and receives transcripts back. All WebSocket plumbing (ws:// or wss://,
// reconnect, framing) is delegated to net::WsClient (Boost.Beast); this class
// only does float→int16 conversion and JSON transcript parsing.
#include "transcriber/transcriber.h"
#include "transcriber/parakeet_transcriber.h"  // ParakeetVadParams
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
    RemoteParakeetTranscriber(std::string url, std::string api_key, std::string model = "",
                              ParakeetVadParams vad = {});
    ~RemoteParakeetTranscriber() override;

    // Update server-side VAD tuning for this connection at runtime (no reconnect).
    void set_vad_params(const ParakeetVadParams& params);

    bool load_model(const std::string& path) override;  // path ignored; connects to the server
    void set_language(const std::string& lang) override;
    void set_translate(bool) override {}
    void feed_audio(const float* samples, size_t count) override;
    std::vector<TranscriptSegment> process() override;
    bool is_model_loaded() const override { return connected_.load(); }

private:
    void on_message(const uint8_t* data, size_t len, bool is_binary);
    void on_state(net::WsState state, const std::string& detail);
    void send_vad_params();  // sends a set_vad control frame if connected

    std::string url_;
    std::string api_key_;
    std::string model_;
    std::string language_ = "auto";

    std::mutex vad_mutex_;
    ParakeetVadParams vad_;

    std::unique_ptr<net::WsClient> ws_;
    std::atomic<bool> connected_{false};

    std::mutex result_mutex_;
    std::vector<TranscriptSegment> result_queue_;

    static constexpr int kSampleRate = 16000;
};

} // namespace ais
