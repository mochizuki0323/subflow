#include "core/logger.h"
#include "core/engine.h"
#include "ipc/protocol.h"
#include "audio/audio_buffer.h"
#include "transcriber/deepgram_transcriber.h"
#include "transcriber/gladia_transcriber.h"
#include "transcriber/parakeet_transcriber.h"
#include "transcriber/remote_parakeet_transcriber.h"
#include <chrono>
#include <cstring>

namespace ais {

Engine::Engine(const Config& config)
    : config_(config), ws_server_(config.ws_port) {
    audio_source_ = create_audio_source();
    if (config_.provider == "parakeet") {
        ParakeetTranscriber::VadParams vp;
        vp.threshold = config_.parakeet_vad_threshold;
        vp.min_silence = config_.parakeet_vad_min_silence;
        vp.min_speech = config_.parakeet_vad_min_speech;
        vp.max_speech = config_.parakeet_vad_max_speech;
        vp.partial_interval = config_.parakeet_partial_interval;
        transcriber_ = std::make_unique<ParakeetTranscriber>(
            config_.parakeet_model_dir, config_.parakeet_model_type,
            config_.parakeet_vad_model, vp);
    } else if (config_.provider == "remote_parakeet") {
        transcriber_ = std::make_unique<RemoteParakeetTranscriber>(
            config_.remote_parakeet_url, config_.remote_parakeet_api_key);
    } else if (config_.provider == "gladia") {
        transcriber_ = std::make_unique<GladiaTranscriber>(
            config_.gladia_api_key, config_.gladia_model, config_.gladia_config);
    } else {
        transcriber_ = std::make_unique<DeepgramTranscriber>(
            config_.deepgram_api_key, config_.deepgram_model, config_.deepgram_extra_params);
    }

    // Forward log messages to WebSocket clients
    Logger::instance().set_callback([this](Logger::Level level, const std::string& message) {
        const char* levels[] = {"debug", "info", "warn", "error"};
        ws_server_.broadcast(make_message(msg::LOG, {
            {"level", levels[static_cast<int>(level)]},
            {"message", message}
        }));
    });

    // Load denoiser if configured at startup
    if (config_.denoise_enabled && !config_.denoise_model_path.empty()) {
        apply_denoise_config(config_.denoise_model_path, config_.denoise_architecture, true);
    }
}

Engine::~Engine() {
    stop();
}

void Engine::run() {
    running_ = true;

    transcriber_->set_language(config_.language);
    transcriber_->load_model("");

    setup_command_handlers();

    // Monitor audio source changes
    audio_source_->on_source_list_changed([this](auto /*sources*/) {
        send_source_list();
    });

    // Start WebSocket server (non-blocking, runs on its own thread)
    ws_server_.start();

    // Start pipeline on a dedicated thread
    pipeline_thread_ = std::thread([this]() { pipeline_loop(); });

    // Block on main thread - could add signal handling here
    LOG_INFO("Engine running. Press Ctrl+C to exit.");
    while (running_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

void Engine::stop() {
    running_ = false;
    if (pipeline_thread_.joinable()) {
        pipeline_thread_.join();
    }
    audio_source_->stop_capture();
    ws_server_.stop();
}

void Engine::setup_command_handlers() {
    ws_server_.on_command(cmd::LIST_SOURCES, [this](const json& /*data*/) {
        send_source_list();
    });

    ws_server_.on_command(cmd::SELECT_SOURCE, [this](const json& data) {
        uint32_t id = data.value("id", 0u);
        if (id > 0) {
            // Find source name for UI display
            auto sources = audio_source_->list_sources();
            capture_source_name_ = "";
            for (const auto& s : sources) {
                if (s.id == id) {
                    capture_source_name_ = s.name;
                    break;
                }
            }
            capture_source_id_ = id;
            audio_source_->start_capture(id);
            current_state_ = "capturing";
            send_status();
        }
    });

    ws_server_.on_command(cmd::LOAD_MODEL, [this](const json& data) {
        std::string key = data.value("api_key", "");
        if (!key.empty()) {
            if (config_.provider == "gladia") {
                config_.gladia_api_key = key;
                transcriber_ = std::make_unique<GladiaTranscriber>(
                    config_.gladia_api_key, config_.gladia_model, config_.gladia_config);
            } else {
                config_.deepgram_api_key = key;
                transcriber_ = std::make_unique<DeepgramTranscriber>(
                    config_.deepgram_api_key, config_.deepgram_model, config_.deepgram_extra_params);
            }
            transcriber_->set_language(config_.language);
            if (transcriber_->load_model("")) {
                ws_server_.broadcast(make_message(msg::MODEL_LOADED, {
                    {"api_key_set", true},
                    {"language", config_.language}
                }));
            } else {
                ws_server_.broadcast(make_message(msg::ERR, {
                    {"message", "Failed to start " + config_.provider + " connection (check API key)"}
                }));
            }
            send_status();
        }
    });

    ws_server_.on_command(cmd::SET_LANGUAGE, [this](const json& data) {
        config_.language = data.value("language", "auto");
        transcriber_->set_language(config_.language);
        LOG_INFO("Language set to: " + config_.language);
        send_status();
    });

    ws_server_.on_command(cmd::SET_TRANSLATE, [this](const json& data) {
        config_.translate = data.value("translate", false);
        transcriber_->set_translate(config_.translate);
        LOG_INFO(std::string("Translate: ") + (config_.translate ? "on" : "off"));
        send_status();
    });

    ws_server_.on_command(cmd::SET_SUBTITLE_MODE, [this](const json& data) {
        config_.subtitle_mode = data.value("mode", "original");
        LOG_INFO("Subtitle mode set to: " + config_.subtitle_mode);
        send_status();
    });

    ws_server_.on_command(cmd::SET_DENOISE, [this](const json& data) {
        bool enabled = data.value("enabled", false);
        std::string model_path = data.value("model_path", "");
        std::string architecture = data.value("architecture", "");
        apply_denoise_config(model_path, architecture, enabled);
        send_status();
    });

    ws_server_.on_command(cmd::SET_VAD, [this](const json& data) {
        // VAD tuning only applies to the local Parakeet transcriber.
        if (config_.provider != "parakeet" || !transcriber_) return;
        ParakeetTranscriber::VadParams p;
        p.threshold = data.value("threshold", 0.3f);
        p.min_silence = data.value("min_silence", 0.5f);
        p.min_speech = data.value("min_speech", 0.25f);
        p.max_speech = data.value("max_speech", 15.0f);
        p.partial_interval = data.value("partial_interval", 0.2f);
        static_cast<ParakeetTranscriber*>(transcriber_.get())->set_vad_params(p);
    });

    ws_server_.on_command(cmd::START, [this](const json& /*data*/) {
        current_state_ = "running";
        send_status();
    });

    ws_server_.on_command(cmd::STOP, [this](const json& /*data*/) {
        audio_source_->stop_capture();
        current_state_ = "idle";
        send_status();
    });
}

void Engine::pipeline_loop() {
    constexpr size_t CHUNK_SIZE = 16000; // 1 second of audio
    std::vector<float> chunk(CHUNK_SIZE);
    auto last_level_broadcast = std::chrono::steady_clock::now();
    auto last_denoise_log = std::chrono::steady_clock::now();
    uint64_t denoise_chunks_processed = 0;
    bool was_connected = transcriber_->is_model_loaded();

    while (running_) {
        auto& buffer = audio_source_->get_buffer();
        size_t read = buffer.read(chunk.data(), CHUNK_SIZE);

        bool now_connected = transcriber_->is_model_loaded();
        if (now_connected != was_connected) {
            was_connected = now_connected;
            send_status();
        }

        if (read > 0) {
            // Calculate audio level (RMS) on raw input
            float sum_sq = 0;
            for (size_t i = 0; i < read; ++i) sum_sq += chunk[i] * chunk[i];
            audio_level_.store(std::sqrt(sum_sq / read));

            if (now_connected) {
                const float* audio_data = chunk.data();
                size_t audio_len = read;
                std::vector<float> denoised_buf;

                if (denoise_active_.load() && denoiser_.is_loaded()) {
                    float rms_before = audio_level_.load();

                    int32_t frame_shift = denoiser_.get_frame_shift();
                    if (frame_shift <= 0) frame_shift = static_cast<int32_t>(read);

                    for (size_t offset = 0; offset < read; offset += frame_shift) {
                        int32_t n = static_cast<int32_t>(
                            std::min<size_t>(frame_shift, read - offset));
                        auto out = denoiser_.process(chunk.data() + offset, n, 16000);
                        denoised_buf.insert(denoised_buf.end(), out.begin(), out.end());
                    }

                    if (!denoised_buf.empty()) {
                        audio_data = denoised_buf.data();
                        audio_len = denoised_buf.size();
                    }

                    ++denoise_chunks_processed;
                    auto now_log = std::chrono::steady_clock::now();
                    if (now_log - last_denoise_log > std::chrono::seconds(10)) {
                        last_denoise_log = now_log;
                        float rms_after = 0;
                        if (audio_len > 0) {
                            float sq = 0;
                            for (size_t i = 0; i < audio_len; ++i) sq += audio_data[i] * audio_data[i];
                            rms_after = std::sqrt(sq / audio_len);
                        }
                        float reduction_pct = (rms_before > 1e-6f)
                            ? (1.0f - rms_after / rms_before) * 100.0f : 0.0f;
                        char buf[256];
                        std::snprintf(buf, sizeof(buf),
                            "Denoise active: chunks=%llu, RMS before=%.4f, after=%.4f, reduction=%.1f%%",
                            (unsigned long long)denoise_chunks_processed, rms_before, rms_after, reduction_pct);
                        LOG_INFO(std::string(buf));
                    }
                }

                transcriber_->feed_audio(audio_data, audio_len);

                auto segments = transcriber_->process();
                for (const auto& seg : segments) {
                    ws_server_.broadcast(make_message(msg::TRANSCRIPT, seg.to_json()));
                }
            }

            // Broadcast audio level periodically (every 500ms)
            auto now = std::chrono::steady_clock::now();
            if (now - last_level_broadcast > std::chrono::milliseconds(500)) {
                last_level_broadcast = now;
                ws_server_.broadcast(make_message("audio_level", {
                    {"level", audio_level_.load()}
                }));
            }
        }

        // Sleep briefly to avoid busy-waiting
        if (read == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    }
}

void Engine::send_source_list() {
    auto sources = audio_source_->list_sources();
    LOG_INFO("Audio source list updated: " + std::to_string(sources.size()) + " entries");
    json source_array = json::array();
    for (const auto& s : sources) {
        source_array.push_back(s.to_json());
    }
    ws_server_.broadcast(make_message(msg::SOURCES, source_array));
}

void Engine::send_status() {
    ws_server_.broadcast(make_message(msg::STATUS, {
        {"state", current_state_},
        {"language", config_.language},
        {"model_loaded", transcriber_->is_model_loaded()},
        {"subtitle_mode", config_.subtitle_mode},
        {"capture_source_id", capture_source_id_},
        {"capture_source_name", capture_source_name_},
        {"audio_level", audio_level_.load()},
        {"denoise_enabled", denoise_active_.load()},
        {"denoise_loaded", denoiser_.is_loaded()}
    }));
}

void Engine::apply_denoise_config(const std::string& model_path,
                                  const std::string& architecture, bool enabled) {
    if (!enabled) {
        denoise_active_ = false;
        LOG_INFO("Denoiser disabled");
        return;
    }

    if (model_path.empty() || architecture.empty()) {
        LOG_WARN("Denoise enabled but model_path or architecture is empty");
        denoise_active_ = false;
        return;
    }

    if (denoiser_.is_loaded() && config_.denoise_model_path == model_path) {
        denoise_active_ = true;
        return;
    }

    if (denoiser_.load(model_path, architecture)) {
        config_.denoise_model_path = model_path;
        config_.denoise_architecture = architecture;
        denoise_active_ = true;
    } else {
        denoise_active_ = false;
        ws_server_.broadcast(make_message(msg::ERR, {
            {"message", "Failed to load denoise model: " + model_path}
        }));
    }
}

} // namespace ais
