#pragma once
// Shared sherpa-onnx offline recognizer. A single instance is created for the
// whole server and decodes every session's utterances, so model weights live in
// memory exactly once regardless of the number of connected clients.
//
// Thread-affinity: decode_*() must be invoked from a single thread (the
// DecodeScheduler's dispatcher). Because the recognizer is never touched
// concurrently, no internal locking is required.
#include <cstdint>
#include <string>
#include <vector>

struct SherpaOnnxOfflineRecognizer;  // opaque (sherpa-onnx C API) — keeps the header out of this interface

namespace ais {

struct ParakeetModelConfig {
    std::string model_dir;
    std::string model_type = "nemo_transducer";  // "nemo_ctc" | "nemo_transducer"
    int num_threads = 4;
    std::string provider = "cpu";  // "cpu" | "cuda"
};

// One utterance to decode: a pointer into caller-owned 16 kHz mono float32 PCM.
struct DecodeInput {
    const float* samples = nullptr;
    int32_t count = 0;
};

class ParakeetModel {
public:
    explicit ParakeetModel(ParakeetModelConfig config);
    ~ParakeetModel();

    ParakeetModel(const ParakeetModel&) = delete;
    ParakeetModel& operator=(const ParakeetModel&) = delete;

    bool load();
    bool is_loaded() const { return recognizer_ != nullptr; }

    // Decode a batch of independent utterances in one batched forward pass.
    // Returns one trimmed transcript per input, in order (empty when no text).
    // This batched primitive is also the on-ramp to GPU dynamic batching.
    std::vector<std::string> decode_batch(const std::vector<DecodeInput>& inputs);
    std::string decode_one(const float* samples, int32_t count);

    static constexpr int kSampleRate = 16000;

private:
    std::string resolve_file(const std::string& name) const;

    ParakeetModelConfig config_;
    const SherpaOnnxOfflineRecognizer* recognizer_ = nullptr;
};

} // namespace ais
