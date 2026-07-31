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

    // Samples the producer had to throw away because the consumer fell behind.
    // write() has always returned a short count when the buffer is full; nothing
    // ever looked at it, so overruns were invisible. Monotonic within a session.
    size_t dropped() const;

    void clear();

private:
    std::vector<float> buffer_;
    std::atomic<size_t> write_pos_{0};
    std::atomic<size_t> read_pos_{0};
    std::atomic<size_t> dropped_{0};
    size_t capacity_;
};

} // namespace ais
