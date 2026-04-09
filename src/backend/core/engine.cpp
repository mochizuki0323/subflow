#include "core/logger.h"
#include "core/engine.h"
#include "ipc/protocol.h"
#include "audio/audio_buffer.h"
#include "transcriber/deepgram_transcriber.h"
#include <chrono>
#include <cstring>

namespace ais {

Engine::Engine(const Config& config)
    : config_(config), ws_server_(config.ws_port) {
    audio_source_ = create_audio_source();
    transcriber_ = std::make_unique<DeepgramTranscriber>(
        config_.deepgram_api_key, config_.deepgram_model, config_.deepgram_extra_params);

    // Forward log messages to WebSocket clients
    Logger::instance().set_callback([this](Logger::Level level, const std::string& message) {
        const char* levels[] = {"debug", "info", "warn", "error"};
        ws_server_.broadcast(make_message(msg::LOG, {
            {"level", levels[static_cast<int>(level)]},
            {"message", message}
        }));
    });
}

Engine::~Engine() {
    stop();
}

void Engine::run() {
    running_ = true;

    // Always attempt to connect to Deepgram on startup.
    transcriber_->set_language(config_.language);
    transcriber_->load_model(""); // path unused by DeepgramTranscriber

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

    // Repurposed: frontend sends this when the user updates the Deepgram API
    // key and the backend needs to reconnect with the new key.
    ws_server_.on_command(cmd::LOAD_MODEL, [this](const json& data) {
        std::string key = data.value("api_key", "");
        if (!key.empty()) {
            config_.deepgram_api_key = key;
            // Re-create transcriber with the new key and reconnect.
            transcriber_ = std::make_unique<DeepgramTranscriber>(
        config_.deepgram_api_key, config_.deepgram_model, config_.deepgram_extra_params);
            transcriber_->set_language(config_.language);
            if (transcriber_->load_model("")) {
                ws_server_.broadcast(make_message(msg::MODEL_LOADED, {
                    {"api_key_set", true},
                    {"language", config_.language}
                }));
            } else {
                ws_server_.broadcast(make_message(msg::ERR, {
                    {"message", "Failed to start Deepgram connection (check API key)"}
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

    while (running_) {
        auto& buffer = audio_source_->get_buffer();
        size_t read = buffer.read(chunk.data(), CHUNK_SIZE);

        if (read > 0) {
            // Calculate audio level (RMS)
            float sum_sq = 0;
            for (size_t i = 0; i < read; ++i) sum_sq += chunk[i] * chunk[i];
            audio_level_.store(std::sqrt(sum_sq / read));

            if (transcriber_->is_model_loaded()) {
                transcriber_->feed_audio(chunk.data(), read);

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
        {"audio_level", audio_level_.load()}
    }));
}

} // namespace ais
