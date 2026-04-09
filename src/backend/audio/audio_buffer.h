#pragma once
#include <atomic>
#include <cstddef>
#include <vector>

namespace ais {

// Single-producer single-consumer lock-free ring buffer for float32 PCM audio.
// Producer: audio capture thread. Consumer: transcription thread.
class AudioRingBuffer {
public:
    explicit AudioRingBuffer(size_t capacity = 16000 * 60); // 60 seconds at 16kHz

    // Producer: write samples into the buffer. Returns number of samples written.
    size_t write(const float* data, size_t count);

    // Consumer: read samples from the buffer. Returns number of samples read.
    size_t read(float* data, size_t max_count);

    // Consumer: peek at available samples without consuming them.
    size_t available() const;

    void clear();

private:
    std::vector<float> buffer_;
    std::atomic<size_t> write_pos_{0};
    std::atomic<size_t> read_pos_{0};
    size_t capacity_;
};

} // namespace ais
