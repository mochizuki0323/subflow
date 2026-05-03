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
#include <audiopolicy.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>
#include <propvarutil.h>
#include <tlhelp32.h>
#include <psapi.h>

#include <cmath>
#include <cstring>
#include <sstream>
#include <unordered_set>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "propsys.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "avrt.lib")

// MinGW lacks audioclientactivationparams.h — define the structs manually.
#ifndef __AUDIOCLIENT_ACTIVATION_PARAMS_DEFINED__
#define __AUDIOCLIENT_ACTIVATION_PARAMS_DEFINED__

typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1,
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef enum PROCESS_LOOPBACK_MODE {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1,
} PROCESS_LOOPBACK_MODE;

typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    DWORD TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    };
} AUDIOCLIENT_ACTIVATION_PARAMS;

#endif // __AUDIOCLIENT_ACTIVATION_PARAMS_DEFINED__

// VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK may not be defined in older MinGW.
#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

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

std::string get_process_name(DWORD pid) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return {};
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    std::string name;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == pid) {
                name = wide_to_utf8(pe.szExeFile);
                // Strip .exe suffix for cleaner display
                if (name.size() > 4) {
                    auto ext = name.substr(name.size() - 4);
                    for (auto& c : ext) c = static_cast<char>(std::tolower(c));
                    if (ext == ".exe") name.resize(name.size() - 4);
                }
                break;
            }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return name;
}

struct ComGuard {
    bool active;
    ~ComGuard() { if (active) CoUninitialize(); }
};

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

static bool supports_process_loopback() {
    typedef LONG (WINAPI *RtlGetVersionPtr)(OSVERSIONINFOW*);
    auto ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return false;
    auto fn = reinterpret_cast<RtlGetVersionPtr>(GetProcAddress(ntdll, "RtlGetVersion"));
    if (!fn) return false;
    OSVERSIONINFOW osvi{};
    osvi.dwOSVersionInfoSize = sizeof(osvi);
    if (fn(&osvi) != 0) return false;
    return osvi.dwBuildNumber >= 20348;
}

std::vector<AudioSourceInfo> WasapiAudioSource::list_sources() {
    HRESULT hr_com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    ComGuard com_guard{SUCCEEDED(hr_com)};
    if (FAILED(hr_com) && hr_com != RPC_E_CHANGED_MODE) {
        LOG_ERROR("Wasapi: CoInitializeEx failed in list_sources, hr=" + hresult_hex(hr_com));
        return {};
    }

    std::lock_guard<std::mutex> lock(list_mutex_);
    sources_.clear();
    std::unordered_set<std::wstring> seen_device_ids;
    std::unordered_set<DWORD> seen_pids;

    std::vector<AudioSourceInfo> out;

    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr) || !enumerator) {
        LOG_ERROR("Wasapi: failed to create device enumerator, hr=" + hresult_hex(hr));
        return out;
    }

    // --- Enumerate per-process audio sessions (Windows 10 Build 20348+ only) ---
    const bool has_process_loopback = supports_process_loopback();
    if (!has_process_loopback) {
        LOG_INFO("Wasapi: per-process capture not available (requires Windows 10 Build 20348+), showing device sources only");
    }

    if (has_process_loopback) {
    IMMDevice* default_render = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &default_render);
    if (SUCCEEDED(hr) && default_render) {
        IAudioSessionManager2* session_mgr = nullptr;
        hr = default_render->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL,
                                      nullptr, (void**)&session_mgr);
        if (SUCCEEDED(hr) && session_mgr) {
            IAudioSessionEnumerator* session_enum = nullptr;
            hr = session_mgr->GetSessionEnumerator(&session_enum);
            if (SUCCEEDED(hr) && session_enum) {
                int count = 0;
                session_enum->GetCount(&count);
                for (int i = 0; i < count; ++i) {
                    IAudioSessionControl* ctrl = nullptr;
                    if (FAILED(session_enum->GetSession(i, &ctrl)) || !ctrl) continue;

                    IAudioSessionControl2* ctrl2 = nullptr;
                    hr = ctrl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctrl2);
                    ctrl->Release();
                    if (FAILED(hr) || !ctrl2) continue;

                    // Skip system sounds session
                    if (ctrl2->IsSystemSoundsSession() == S_OK) {
                        ctrl2->Release();
                        continue;
                    }

                    DWORD pid = 0;
                    if (FAILED(ctrl2->GetProcessId(&pid)) || pid == 0) {
                        ctrl2->Release();
                        continue;
                    }

                    // Skip duplicate PIDs
                    if (seen_pids.count(pid)) {
                        ctrl2->Release();
                        continue;
                    }
                    seen_pids.insert(pid);

                    std::string proc_name = get_process_name(pid);
                    if (proc_name.empty()) proc_name = "PID " + std::to_string(pid);

                    ctrl2->Release();

                    SourceEntry entry{};
                    entry.is_process = true;
                    entry.process_id = pid;
                    entry.loopback = false;
                    entry.description = "Application audio";
                    entry.media_class = "Stream/Output/Audio";
                    sources_.push_back(entry);

                    AudioSourceInfo info;
                    info.id = static_cast<uint32_t>(sources_.size());
                    info.name = proc_name + " (PID " + std::to_string(pid) + ")";
                    info.description = entry.description;
                    info.media_class = entry.media_class;
                    out.push_back(std::move(info));
                }
                session_enum->Release();
            }
            session_mgr->Release();
        }
        default_render->Release();
    }
    } // end if (has_process_loopback)

    // --- Enumerate audio devices (loopback + microphone) ---
    auto enumerate_flow = [&](EDataFlow flow, DWORD state_mask, bool loopback,
                              const std::string& desc,
                              const std::string& media_class) {
        IMMDeviceCollection* collection = nullptr;
        HRESULT hr_enum = enumerator->EnumAudioEndpoints(flow, state_mask, &collection);
        if (FAILED(hr_enum) || !collection) return;

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
            if (seen_device_ids.count(id_copy)) {
                CoTaskMemFree(id);
                device->Release();
                continue;
            }
            seen_device_ids.insert(id_copy);

            SourceEntry entry{};
            entry.device_id = id_copy;
            entry.loopback = loopback;
            entry.is_process = false;
            entry.process_id = 0;
            entry.description = desc;
            entry.media_class = media_class;
            sources_.push_back(entry);

            CoTaskMemFree(id);
            device->Release();

            AudioSourceInfo info;
            info.id = static_cast<uint32_t>(sources_.size());
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

    LOG_INFO("Wasapi: list_sources found " + std::to_string(out.size()) +
             " entries (" + std::to_string(seen_pids.size()) + " app sessions)");

    enumerator->Release();
    return out;
}

bool WasapiAudioSource::start_capture(uint32_t source_id) {
    stop_capture();
    if (source_id == 0 || source_id > sources_.size()) {
        LOG_ERROR("Wasapi: invalid source id");
        return false;
    }
    capturing_ = true;
    capture_thread_ = std::thread(&WasapiAudioSource::capture_thread_main, this, source_id);
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
    ComGuard com_guard{SUCCEEDED(hr)};
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        LOG_ERROR("Wasapi: CoInitializeEx in capture thread failed, hr=" + hresult_hex(hr));
        return;
    }

    SourceEntry selected;
    {
        std::lock_guard<std::mutex> lock(list_mutex_);
        if (source_id == 0 || source_id > sources_.size()) return;
        selected = sources_[source_id - 1];
    }

    if (selected.is_process) {
        LOG_INFO("Wasapi: starting per-process capture for PID " + std::to_string(selected.process_id));
        if (!capture_process(selected)) {
            LOG_WARN("Wasapi: per-process capture unavailable, falling back to default device loopback");
            SourceEntry fallback{};
            fallback.is_process = false;
            fallback.loopback = true;
            fallback.description = "WASAPI loopback (fallback)";
            // Empty device_id signals capture_device to use the default render endpoint
            capture_device(fallback);
        }
    } else {
        LOG_INFO("Wasapi: starting device capture (" + selected.description + ")");
        capture_device(selected);
    }
}

void WasapiAudioSource::capture_device(const SourceEntry& entry) {
    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr) || !enumerator) {
        LOG_ERROR("Wasapi: enumerator in thread failed, hr=" + hresult_hex(hr));
        return;
    }

    IMMDevice* device = nullptr;
    if (entry.device_id.empty()) {
        hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    } else {
        hr = enumerator->GetDevice(entry.device_id.c_str(), &device);
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
    const DWORD stream_flags = entry.loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
    hr = audio_client->Initialize(AUDCLNT_SHAREMODE_SHARED, stream_flags,
                                    buffer_duration, 0, pwfx, nullptr);
    CoTaskMemFree(pwfx);

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
        if (next_packet == 0) { Sleep(1); continue; }

        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;

        if (frames > 0 && data && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
            if (is_float) {
                push_resampled_mono(reinterpret_cast<const float*>(data), frames, channels, sample_rate);
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

    if (avrt_handle) AvRevertMmThreadCharacteristics(avrt_handle);
    audio_client->Stop();
    capture->Release();
    audio_client->Release();
}

// IActivateAudioInterfaceCompletionHandler implementation for async activation
class ActivateAudioInterfaceHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    ActivateAudioInterfaceHandler() : ref_count_(1) {
        event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }
    ~ActivateAudioInterfaceHandler() {
        if (event_) CloseHandle(event_);
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&ref_count_); }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG c = InterlockedDecrement(&ref_count_);
        if (c == 0) delete this;
        return c;
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        op_ = op;
        if (op_) op_->AddRef();
        SetEvent(event_);
        return S_OK;
    }

    bool wait(DWORD timeout_ms = 5000) {
        return WaitForSingleObject(event_, timeout_ms) == WAIT_OBJECT_0;
    }

    HRESULT get_audio_client(IAudioClient** client) {
        if (!op_) return E_FAIL;
        HRESULT hr_activate = S_OK;
        IUnknown* punk = nullptr;
        HRESULT hr = op_->GetActivateResult(&hr_activate, &punk);
        if (FAILED(hr) || FAILED(hr_activate) || !punk) {
            if (punk) punk->Release();
            return FAILED(hr) ? hr : hr_activate;
        }
        hr = punk->QueryInterface(__uuidof(IAudioClient), (void**)client);
        punk->Release();
        return hr;
    }

private:
    LONG ref_count_;
    HANDLE event_ = nullptr;
    IActivateAudioInterfaceAsyncOperation* op_ = nullptr;
};

bool WasapiAudioSource::capture_process(const SourceEntry& entry) {
    AUDIOCLIENT_ACTIVATION_PARAMS activation_params{};
    activation_params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation_params.ProcessLoopbackParams.TargetProcessId = entry.process_id;
    activation_params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activate_pv{};
    activate_pv.vt = VT_BLOB;
    activate_pv.blob.cbSize = sizeof(activation_params);
    activate_pv.blob.pBlobData = reinterpret_cast<BYTE*>(&activation_params);

    auto* handler = new ActivateAudioInterfaceHandler();
    IActivateAudioInterfaceAsyncOperation* async_op = nullptr;

    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activate_pv,
        handler,
        &async_op);

    if (FAILED(hr)) {
        LOG_WARN("Wasapi: ActivateAudioInterfaceAsync failed, hr=" + hresult_hex(hr) +
                 " — per-process capture requires Windows 10 Build 20348+ (your build may be older)");
        handler->Release();
        return false;
    }

    if (!handler->wait(5000)) {
        LOG_ERROR("Wasapi: ActivateAudioInterfaceAsync timed out");
        if (async_op) async_op->Release();
        handler->Release();
        return false;
    }

    IAudioClient* audio_client = nullptr;
    hr = handler->get_audio_client(&audio_client);
    if (async_op) async_op->Release();
    handler->Release();

    if (FAILED(hr) || !audio_client) {
        LOG_WARN("Wasapi: process loopback activation failed, hr=" + hresult_hex(hr));
        return false;
    }

    WAVEFORMATEX* pwfx = nullptr;
    hr = audio_client->GetMixFormat(&pwfx);
    if (FAILED(hr) || !pwfx) {
        audio_client->Release();
        LOG_ERROR("Wasapi: GetMixFormat failed for process loopback, hr=" + hresult_hex(hr));
        return false;
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
    hr = audio_client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                                    buffer_duration, 0, pwfx, nullptr);
    CoTaskMemFree(pwfx);

    if (FAILED(hr)) {
        audio_client->Release();
        LOG_ERROR("Wasapi: Initialize failed for process loopback, hr=" + hresult_hex(hr));
        return false;
    }

    IAudioCaptureClient* capture = nullptr;
    hr = audio_client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
    if (FAILED(hr) || !capture) {
        audio_client->Release();
        LOG_ERROR("Wasapi: GetService failed for process loopback, hr=" + hresult_hex(hr));
        return false;
    }

    hr = audio_client->Start();
    if (FAILED(hr)) {
        capture->Release();
        audio_client->Release();
        LOG_ERROR("Wasapi: Start failed for process loopback, hr=" + hresult_hex(hr));
        return false;
    }

    LOG_INFO("Wasapi: per-process loopback active for PID " + std::to_string(entry.process_id));

    DWORD task_index = 0;
    HANDLE avrt_handle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);
    std::vector<float> float_scratch;

    while (capturing_.load()) {
        UINT32 next_packet = 0;
        hr = capture->GetNextPacketSize(&next_packet);
        if (FAILED(hr)) break;
        if (next_packet == 0) { Sleep(1); continue; }

        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;

        if (frames > 0 && data && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
            if (is_float) {
                push_resampled_mono(reinterpret_cast<const float*>(data), frames, channels, sample_rate);
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

    if (avrt_handle) AvRevertMmThreadCharacteristics(avrt_handle);
    audio_client->Stop();
    capture->Release();
    audio_client->Release();
    return true;
}

} // namespace ais
