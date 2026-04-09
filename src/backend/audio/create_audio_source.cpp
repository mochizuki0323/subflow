#include "audio/audio_source.h"

#if defined(_WIN32)
#include "audio/wasapi/wasapi_audio_source.h"
#elif defined(__linux__)
#include "audio/pipewire/pw_audio_source.h"
#else
#error "Unsupported platform: add an IAudioSource implementation for this OS."
#endif

namespace ais {

std::unique_ptr<IAudioSource> create_audio_source() {
#if defined(_WIN32)
    return std::make_unique<WasapiAudioSource>();
#else
    return std::make_unique<PwAudioSource>();
#endif
}

} // namespace ais
