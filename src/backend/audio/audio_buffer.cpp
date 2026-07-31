#include "audio/audio_buffer.h"
#include <algorithm>
#include <cstring>

namespace ais {

AudioRingBuffer::AudioRingBuffer(size_t capacity)
    : buffer_(capacity), capacity_(capacity) {}

size_t AudioRingBuffer::write(const float* data, size_t count) {
    size_t wp = write_pos_.load(std::memory_order_relaxed);
    size_t rp = read_pos_.load(std::memory_order_acquire);

    // Available space
    size_t used = (wp - rp + capacity_) % capacity_;
    size_t free_space = capacity_ - 1 - used;
    size_t to_write = std::min(count, free_space);
    if (to_write < count) {
        dropped_.fetch_add(count - to_write, std::memory_order_relaxed);
    }

    for (size_t i = 0; i < to_write; ++i) {
        buffer_[(wp + i) % capacity_] = data[i];
    }

    write_pos_.store((wp + to_write) % capacity_, std::memory_order_release);
    return to_write;
}

size_t AudioRingBuffer::read(float* data, size_t max_count) {
    size_t rp = read_pos_.load(std::memory_order_relaxed);
    size_t wp = write_pos_.load(std::memory_order_acquire);

    size_t avail = (wp - rp + capacity_) % capacity_;
    size_t to_read = std::min(max_count, avail);

    for (size_t i = 0; i < to_read; ++i) {
        data[i] = buffer_[(rp + i) % capacity_];
    }

    read_pos_.store((rp + to_read) % capacity_, std::memory_order_release);
    return to_read;
}

size_t AudioRingBuffer::available() const {
    size_t wp = write_pos_.load(std::memory_order_acquire);
    size_t rp = read_pos_.load(std::memory_order_acquire);
    return (wp - rp + capacity_) % capacity_;
}

size_t AudioRingBuffer::dropped() const {
    return dropped_.load(std::memory_order_relaxed);
}

void AudioRingBuffer::clear() {
    read_pos_.store(0, std::memory_order_release);
    write_pos_.store(0, std::memory_order_release);
    dropped_.store(0, std::memory_order_relaxed);
}

} // namespace ais
