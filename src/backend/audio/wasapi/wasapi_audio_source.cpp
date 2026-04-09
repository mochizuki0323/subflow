#include "audio/wasapi/wasapi_audio_source.h"
#include "core/logger.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <avrt.h>
#include <audioclient.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>
#include <propvarutil.h>

#include <cmath>
#include <cstring>
#include <sstream>
#include <unordered_set>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "propsys.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "avrt.lib")

namespace ais {

namespace {

std::string wide_to_utf8(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    if (n <= 0) return {};
    std::string out(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), out.data(), n, nullptr, nullptr);
    return out;
}

std::string hresult_hex(HRESULT hr) {
    std::ostringstream ss;
    ss << "0x" << std::hex << std::uppercase << static_cast<unsigned long>(hr);
    return ss.str();
}

const char* flow_name(EDataFlow flow) {
    return flow == eRender ? "render" : "capture";
}

} // namespace

WasapiAudioSource::WasapiAudioSource() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    com_inited_ = SUCCEEDED(hr);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        LOG_ERROR("Wasapi: CoInitializeEx failed, hr=" + hresult_hex(hr));
    }
}

WasapiAudioSource::~WasapiAudioSource() {
    stop_capture();
    if (com_inited_) {
        CoUninitialize();
    }
}

void WasapiAudioSource::on_source_list_changed(SourceChangeCallback cb) {
    source_change_cb_ = std::move(cb);
}

std::vector<AudioSourceInfo> WasapiAudioSource::list_sources() {
    // COM must be initialized on *this* thread. list_sources runs on the WebSocket
    // worker thread, not the thread that constructed WasapiAudioSource.
    HRESULT hr_com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_needs_uninit = SUCCEEDED(hr_com);
    if (FAILED(hr_com) && hr_com != RPC_E_CHANGED_MODE) {
        LOG_ERROR("Wasapi: CoInitializeEx failed in list_sources, hr=" + hresult_hex(hr_com));
        return {};
    }

    struct ComUninit {
        bool active;
        ~ComUninit() {
            if (active) CoUninitialize();
        }
    } com_guard{com_needs_uninit};

    std::lock_guard<std::mutex> lock(list_mutex_);
    devices_.clear();
    std::unordered_set<std::wstring> seen_ids;

    std::vector<AudioSourceInfo> out;

    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr) || !enumerator) {
        LOG_ERROR("Wasapi: failed to create device enumerator, hr=" + hresult_hex(hr));
        return out;
    }

    auto enumerate_flow = [&](EDataFlow flow, DWORD state_mask, bool loopback,
                              const std::string& desc,
                              const std::string& media_class) {
        IMMDeviceCollection* collection = nullptr;
        HRESULT hr_enum = enumerator->EnumAudioEndpoints(flow, state_mask, &collection);
        if (FAILED(hr_enum) || !collection) {
            LOG_ERROR("Wasapi: EnumAudioEndpoints flow=" + std::string(flow_name(flow)) +
                      " state=0x" + std::to_string(state_mask) +
                      " failed, hr=" + hresult_hex(hr_enum));
            return;
        }

        UINT count = 0;
        collection->GetCount(&count);
        for (UINT i = 0; i < count; ++i) {
            IMMDevice* device = nullptr;
            if (FAILED(collection->Item(i, &device)) || !device) continue;

            LPWSTR id = nullptr;
            if (FAILED(device->GetId(&id)) || !id) {
                device->Release();
                continue;
            }

            IPropertyStore* props = nullptr;
            std::string friendly = wide_to_utf8(id);
            if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props)) && props) {
                PROPVARIANT pv;
                PropVariantInit(&pv);
                if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &pv))) {
                    if (pv.vt == VT_LPWSTR && pv.pwszVal) {
                        friendly = wide_to_utf8(pv.pwszVal);
                    }
                }
                PropVariantClear(&pv);
                props->Release();
            }

            std::wstring id_copy(id);
            if (seen_ids.find(id_copy) != seen_ids.end()) {
                CoTaskMemFree(id);
                device->Release();
                continue;
            }
            seen_ids.insert(id_copy);
            devices_.push_back(DeviceEntry{id_copy, loopback, desc, media_class});
            CoTaskMemFree(id);
            device->Release();

            AudioSourceInfo info;
            info.id = static_cast<uint32_t>(devices_.size());
            info.name = std::move(friendly);
            info.description = desc;
            info.media_class = media_class;
            out.push_back(std::move(info));
        }

        collection->Release();
    };

    enumerate_flow(eRender, DEVICE_STATE_ACTIVE, true, "WASAPI loopback", "Audio/Sink");
    enumerate_flow(eCapture, DEVICE_STATE_ACTIVE, false, "WASAPI microphone", "Audio/Source");

    if (out.empty()) {
        LOG_WARN("Wasapi: no active endpoints found, retrying with DEVICE_STATEMASK_ALL");
        enumerate_flow(eRender, DEVICE_STATEMASK_ALL, true, "WASAPI loopback", "Audio/Sink");
        enumerate_flow(eCapture, DEVICE_STATEMASK_ALL, false, "WASAPI microphone", "Audio/Source");
    }

    if (out.empty()) {
        auto add_default_endpoint = [&](EDataFlow flow, ERole role, bool loopback,
                                        const std::string& desc,
                                        const std::string& media_class) {
            IMMDevice* device = nullptr;
            HRESULT hr_default = enumerator->GetDefaultAudioEndpoint(flow, role, &device);
            if (FAILED(hr_default) || !device) {
                LOG_WARN("Wasapi: GetDefaultAudioEndpoint flow=" + std::string(flow_name(flow)) +
                         " role=" + std::to_string(static_cast<int>(role)) +
                         " failed, hr=" + hresult_hex(hr_default));
                return;
            }

            LPWSTR id = nullptr;
            if (FAILED(device->GetId(&id)) || !id) {
                device->Release();
                return;
            }

            std::wstring id_copy(id);
            if (seen_ids.find(id_copy) != seen_ids.end()) {
                CoTaskMemFree(id);
                device->Release();
                return;
            }

            IPropertyStore* props = nullptr;
            std::string friendly = wide_to_utf8(id);
            if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props)) && props) {
                PROPVARIANT pv;
                PropVariantInit(&pv);
                if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &pv))) {
                    if (pv.vt == VT_LPWSTR && pv.pwszVal) {
                        friendly = wide_to_utf8(pv.pwszVal);
                    }
                }
                PropVariantClear(&pv);
                props->Release();
            }

            seen_ids.insert(id_copy);
            devices_.push_back(DeviceEntry{id_copy, loopback, desc, media_class});
            CoTaskMemFree(id);
            device->Release();

            AudioSourceInfo info;
            info.id = static_cast<uint32_t>(devices_.size());
            info.name = std::move(friendly);
            info.description = desc;
            info.media_class = media_class;
            out.push_back(std::move(info));
        };

        LOG_WARN("Wasapi: endpoint enumeration still empty, trying default endpoints fallback");
        add_default_endpoint(eRender, eConsole, true, "WASAPI loopback (default)", "Audio/Sink");
        add_default_endpoint(eRender, eMultimedia, true, "WASAPI loopback (default)", "Audio/Sink");
        add_default_endpoint(eCapture, eConsole, false, "WASAPI microphone (default)", "Audio/Source");
        add_default_endpoint(eCapture, eMultimedia, false, "WASAPI microphone (default)", "Audio/Source");
    }

    LOG_INFO("Wasapi: list_sources found " + std::to_string(out.size()) + " endpoints");

    enumerator->Release();
    return out;
}

bool WasapiAudioSource::start_capture(uint32_t source_id) {
    stop_capture();
    if (source_id == 0 || source_id > devices_.size()) {
        LOG_ERROR("Wasapi: invalid source id");
        return false;
    }
    capturing_ = true;
    capture_thread_ = std::thread(&WasapiAudioSource::capture_thread_main, this, source_id);
    LOG_INFO("Wasapi: capture started for device index " + std::to_string(source_id));
    return true;
}

void WasapiAudioSource::stop_capture() {
    capturing_ = false;
    if (capture_thread_.joinable()) {
        capture_thread_.join();
    }
    buffer_.clear();
    resample_pending_.clear();
    resample_phase_ = 0;
}

void WasapiAudioSource::push_resampled_mono(const float* interleaved, size_t frame_count,
                                            uint32_t channels, uint32_t sample_rate) {
    if (channels == 0 || frame_count == 0) return;

    std::vector<float> mono(frame_count);
    if (channels == 1) {
        std::memcpy(mono.data(), interleaved, frame_count * sizeof(float));
    } else {
        for (size_t f = 0; f < frame_count; ++f) {
            double acc = 0;
            for (uint32_t c = 0; c < channels; ++c) {
                acc += interleaved[f * channels + c];
            }
            mono[f] = static_cast<float>(acc / static_cast<double>(channels));
        }
    }

    resample_pending_.insert(resample_pending_.end(), mono.begin(), mono.end());

    constexpr double out_fs = 16000.0;
    const double step = sample_rate / out_fs;

    while (resample_phase_ + 1.0 < static_cast<double>(resample_pending_.size())) {
        const size_t i0 = static_cast<size_t>(resample_phase_);
        const double frac = resample_phase_ - static_cast<double>(i0);
        const size_t i1 = i0 + 1;
        const float s = resample_pending_[i0] * static_cast<float>(1.0 - frac)
                      + resample_pending_[i1] * static_cast<float>(frac);
        buffer_.write(&s, 1);
        resample_phase_ += step;
    }

    const size_t consumed = static_cast<size_t>(resample_phase_);
    if (consumed > 0 && consumed <= resample_pending_.size()) {
        resample_pending_.erase(resample_pending_.begin(), resample_pending_.begin() + consumed);
        resample_phase_ -= static_cast<double>(consumed);
    }
}

void WasapiAudioSource::capture_thread_main(uint32_t source_id) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_needs_uninit = SUCCEEDED(hr);
    struct ComUninit {
        bool active;
        ~ComUninit() {
            if (active) CoUninitialize();
        }
    } com_guard{com_needs_uninit};

    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        LOG_ERROR("Wasapi: CoInitializeEx in capture thread failed, hr=" + hresult_hex(hr));
        return;
    }

    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr) || !enumerator) {
        LOG_ERROR("Wasapi: enumerator in thread failed, hr=" + hresult_hex(hr));
        return;
    }

    IMMDevice* device = nullptr;
    DeviceEntry selected;
    {
        std::lock_guard<std::mutex> lock(list_mutex_);
        if (source_id == 0 || source_id > devices_.size()) {
            enumerator->Release();
            return;
        }
        selected = devices_[source_id - 1];
        hr = enumerator->GetDevice(selected.id.c_str(), &device);
    }
    enumerator->Release();

    if (FAILED(hr) || !device) {
        LOG_ERROR("Wasapi: GetDevice failed, hr=" + hresult_hex(hr));
        return;
    }

    IAudioClient* audio_client = nullptr;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&audio_client);
    device->Release();
    if (FAILED(hr) || !audio_client) {
        LOG_ERROR("Wasapi: Activate IAudioClient failed, hr=" + hresult_hex(hr));
        return;
    }

    WAVEFORMATEX* pwfx = nullptr;
    hr = audio_client->GetMixFormat(&pwfx);
    if (FAILED(hr) || !pwfx) {
        audio_client->Release();
        LOG_ERROR("Wasapi: GetMixFormat failed, hr=" + hresult_hex(hr));
        return;
    }

    const uint32_t channels = pwfx->nChannels;
    const uint32_t sample_rate = pwfx->nSamplesPerSec;
    const bool extensible = (pwfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE);
    bool is_float = false;
    bool is_pcm16 = false;
    if (extensible) {
        auto* wx = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(pwfx);
        is_float = (wx->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
        is_pcm16 = (wx->SubFormat == KSDATAFORMAT_SUBTYPE_PCM) && (pwfx->wBitsPerSample == 16);
    } else {
        is_float = (pwfx->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
        is_pcm16 = (pwfx->wFormatTag == WAVE_FORMAT_PCM) && (pwfx->wBitsPerSample == 16);
    }

    REFERENCE_TIME buffer_duration = 10000000 / 10; // 100 ms
    const DWORD stream_flags = selected.loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
    hr = audio_client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                    stream_flags,
                                    buffer_duration,
                                    0,
                                    pwfx,
                                    nullptr);
    CoTaskMemFree(pwfx);
    pwfx = nullptr;

    if (FAILED(hr)) {
        audio_client->Release();
        LOG_ERROR("Wasapi: Initialize failed, hr=" + hresult_hex(hr));
        return;
    }

    IAudioCaptureClient* capture = nullptr;
    hr = audio_client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
    if (FAILED(hr) || !capture) {
        audio_client->Release();
        LOG_ERROR("Wasapi: GetService IAudioCaptureClient failed, hr=" + hresult_hex(hr));
        return;
    }

    hr = audio_client->Start();
    if (FAILED(hr)) {
        capture->Release();
        audio_client->Release();
        LOG_ERROR("Wasapi: Start failed, hr=" + hresult_hex(hr));
        return;
    }

    DWORD task_index = 0;
    HANDLE avrt_handle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);

    std::vector<float> float_scratch;

    while (capturing_.load()) {
        UINT32 next_packet = 0;
        hr = capture->GetNextPacketSize(&next_packet);
        if (FAILED(hr)) break;
        if (next_packet == 0) {
            Sleep(1);
            continue;
        }

        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;

        if (frames > 0 && data && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
            if (is_float) {
                const float* fp = reinterpret_cast<const float*>(data);
                push_resampled_mono(fp, frames, channels, sample_rate);
            } else if (is_pcm16) {
                const int16_t* sp = reinterpret_cast<const int16_t*>(data);
                float_scratch.resize(static_cast<size_t>(frames) * channels);
                for (size_t i = 0; i < float_scratch.size(); ++i) {
                    float_scratch[i] = static_cast<float>(sp[i]) / 32768.0f;
                }
                push_resampled_mono(float_scratch.data(), frames, channels, sample_rate);
            }
        }

        capture->ReleaseBuffer(frames);
    }

    if (avrt_handle) {
        AvRevertMmThreadCharacteristics(avrt_handle);
    }

    audio_client->Stop();
    capture->Release();
    audio_client->Release();
}

} // namespace ais
