#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace ais {

class Denoiser {
public:
    Denoiser();
    ~Denoiser();

    Denoiser(const Denoiser&) = delete;
    Denoiser& operator=(const Denoiser&) = delete;

    // Load a model. `architecture` is "gtcrn" or "dpdfnet".
    // Returns true on success.
    bool load(const std::string& model_path, const std::string& architecture);

    // Unload the current model and free resources.
    void unload();

    bool is_loaded() const;

    // Process a chunk of audio. Returns denoised samples.
    // Input: float32 PCM normalized to [-1, 1].
    // The caller should feed chunks of get_frame_shift() samples for optimal streaming.
    std::vector<float> process(const float* samples, int32_t n, int32_t sample_rate);

    // Flush any remaining buffered audio. Also resets the denoiser state.
    std::vector<float> flush();

    // Reset the denoiser state for a new stream (e.g., audio source changed).
    void reset();

    int32_t get_sample_rate() const;
    int32_t get_frame_shift() const;

private:
    struct Impl;
    Impl* impl_ = nullptr;
};

} // namespace ais
