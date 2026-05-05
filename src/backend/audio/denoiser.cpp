#include "audio/denoiser.h"
#include "core/logger.h"
#include <sherpa-onnx/c-api/c-api.h>
#include <cstring>

namespace ais {

struct Denoiser::Impl {
    const SherpaOnnxOnlineSpeechDenoiser* handle = nullptr;
    int32_t frame_shift = 0;
    int32_t sample_rate = 0;
};

Denoiser::Denoiser() : impl_(new Impl) {}

Denoiser::~Denoiser() {
    unload();
    delete impl_;
}

bool Denoiser::load(const std::string& model_path, const std::string& architecture) {
    unload();

    SherpaOnnxOnlineSpeechDenoiserConfig config;
    std::memset(&config, 0, sizeof(config));
    config.model.num_threads = 2;

    if (architecture == "gtcrn") {
        config.model.gtcrn.model = model_path.c_str();
    } else if (architecture == "dpdfnet") {
        config.model.dpdfnet.model = model_path.c_str();
    } else {
        LOG_ERROR("Unknown denoise architecture: " + architecture);
        return false;
    }

    impl_->handle = SherpaOnnxCreateOnlineSpeechDenoiser(&config);
    if (!impl_->handle) {
        LOG_ERROR("Failed to create denoiser with model: " + model_path);
        return false;
    }

    impl_->sample_rate = SherpaOnnxOnlineSpeechDenoiserGetSampleRate(impl_->handle);
    impl_->frame_shift = SherpaOnnxOnlineSpeechDenoiserGetFrameShiftInSamples(impl_->handle);

    LOG_INFO("Denoiser loaded: " + model_path +
             " (arch=" + architecture +
             ", sr=" + std::to_string(impl_->sample_rate) +
             ", frame_shift=" + std::to_string(impl_->frame_shift) + ")");
    return true;
}

void Denoiser::unload() {
    if (impl_->handle) {
        SherpaOnnxDestroyOnlineSpeechDenoiser(impl_->handle);
        impl_->handle = nullptr;
        impl_->frame_shift = 0;
        impl_->sample_rate = 0;
    }
}

bool Denoiser::is_loaded() const {
    return impl_->handle != nullptr;
}

std::vector<float> Denoiser::process(const float* samples, int32_t n, int32_t sample_rate) {
    if (!impl_->handle || n <= 0) return {};

    const auto* result = SherpaOnnxOnlineSpeechDenoiserRun(
        impl_->handle, samples, n, sample_rate);

    if (!result || !result->samples || result->n <= 0) {
        if (result) SherpaOnnxDestroyDenoisedAudio(result);
        return {};
    }

    std::vector<float> out(result->samples, result->samples + result->n);
    SherpaOnnxDestroyDenoisedAudio(result);
    return out;
}

std::vector<float> Denoiser::flush() {
    if (!impl_->handle) return {};

    const auto* result = SherpaOnnxOnlineSpeechDenoiserFlush(impl_->handle);
    if (!result || !result->samples || result->n <= 0) {
        if (result) SherpaOnnxDestroyDenoisedAudio(result);
        return {};
    }

    std::vector<float> out(result->samples, result->samples + result->n);
    SherpaOnnxDestroyDenoisedAudio(result);
    return out;
}

void Denoiser::reset() {
    if (impl_->handle) {
        SherpaOnnxOnlineSpeechDenoiserReset(impl_->handle);
    }
}

int32_t Denoiser::get_sample_rate() const {
    return impl_->sample_rate;
}

int32_t Denoiser::get_frame_shift() const {
    return impl_->frame_shift;
}

} // namespace ais
