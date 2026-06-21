#include "parakeet_model.h"
#include "log.h"

#include <sherpa-onnx/c-api/c-api.h>

#include <cstring>
#include <filesystem>

namespace ais {

namespace {

std::string trim(const char* s) {
    if (!s) return {};
    std::string text = s;
    auto b = text.find_first_not_of(" \t\n\r");
    if (b == std::string::npos) return {};
    auto e = text.find_last_not_of(" \t\n\r");
    return text.substr(b, e - b + 1);
}

} // namespace

ParakeetModel::ParakeetModel(ParakeetModelConfig config) : config_(std::move(config)) {}

ParakeetModel::~ParakeetModel() {
    if (recognizer_) SherpaOnnxDestroyOfflineRecognizer(recognizer_);
}

std::string ParakeetModel::resolve_file(const std::string& name) const {
    namespace fs = std::filesystem;
    auto p = fs::path(config_.model_dir) / name;
    if (fs::exists(p)) return p.string();
    return name;
}

bool ParakeetModel::load() {
    if (recognizer_) return true;
    if (config_.model_dir.empty()) {
        LOG_ERROR("ParakeetModel: model_dir not set");
        return false;
    }

    SherpaOnnxOfflineRecognizerConfig config;
    std::memset(&config, 0, sizeof(config));

    config.feat_config.sample_rate = kSampleRate;
    config.feat_config.feature_dim = 80;
    config.decoding_method = "greedy_search";

    std::string tokens_path = resolve_file("tokens.txt");
    config.model_config.tokens = tokens_path.c_str();
    config.model_config.num_threads = config_.num_threads;
    config.model_config.provider = config_.provider.c_str();
    config.model_config.debug = 0;
    config.model_config.model_type = config_.model_type.c_str();

    std::string encoder_path, decoder_path, joiner_path, model_path;
    if (config_.model_type == "nemo_ctc") {
        model_path = resolve_file("model.int8.onnx");
        config.model_config.nemo_ctc.model = model_path.c_str();
        LOG_INFO("ParakeetModel CTC: " + model_path);
    } else {
        encoder_path = resolve_file("encoder.int8.onnx");
        decoder_path = resolve_file("decoder.int8.onnx");
        joiner_path = resolve_file("joiner.int8.onnx");
        config.model_config.transducer.encoder = encoder_path.c_str();
        config.model_config.transducer.decoder = decoder_path.c_str();
        config.model_config.transducer.joiner = joiner_path.c_str();
        LOG_INFO("ParakeetModel transducer: " + encoder_path);
    }

    LOG_INFO("ParakeetModel: creating shared offline recognizer (type=" + config_.model_type +
             ", threads=" + std::to_string(config_.num_threads) + ", provider=" + config_.provider + ")");
    // onnxruntime throws (Ort::Exception) on a corrupt/incomplete model rather
    // than returning null. Because models load lazily on a worker thread, an
    // uncaught throw would std::terminate the whole server — so contain it here
    // and report a clean failure for just this model.
    try {
        recognizer_ = SherpaOnnxCreateOfflineRecognizer(&config);
    } catch (const std::exception& e) {
        LOG_ERROR(std::string("ParakeetModel: exception loading recognizer: ") + e.what());
        recognizer_ = nullptr;
        return false;
    }
    if (!recognizer_) {
        LOG_ERROR("ParakeetModel: failed to create recognizer from " + config_.model_dir);
        return false;
    }
    LOG_INFO("ParakeetModel: recognizer ready");
    return true;
}

std::vector<std::string> ParakeetModel::decode_batch(const std::vector<DecodeInput>& inputs) {
    std::vector<std::string> out(inputs.size());
    if (!recognizer_ || inputs.empty()) return out;

    // One stream per input; streams created in input order so results map 1:1.
    std::vector<const SherpaOnnxOfflineStream*> streams(inputs.size(), nullptr);
    std::vector<const SherpaOnnxOfflineStream*> to_decode;
    to_decode.reserve(inputs.size());

    for (size_t i = 0; i < inputs.size(); ++i) {
        if (!inputs[i].samples || inputs[i].count <= 0) continue;
        const auto* s = SherpaOnnxCreateOfflineStream(recognizer_);
        if (!s) continue;
        SherpaOnnxAcceptWaveformOffline(s, kSampleRate, inputs[i].samples, inputs[i].count);
        streams[i] = s;
        to_decode.push_back(s);
    }

    if (!to_decode.empty()) {
        SherpaOnnxDecodeMultipleOfflineStreams(
            recognizer_, to_decode.data(), static_cast<int32_t>(to_decode.size()));
    }

    for (size_t i = 0; i < streams.size(); ++i) {
        if (!streams[i]) continue;
        const auto* r = SherpaOnnxGetOfflineStreamResult(streams[i]);
        if (r) {
            out[i] = trim(r->text);
            SherpaOnnxDestroyOfflineRecognizerResult(r);
        }
        SherpaOnnxDestroyOfflineStream(streams[i]);
    }
    return out;
}

std::string ParakeetModel::decode_one(const float* samples, int32_t count) {
    auto v = decode_batch({DecodeInput{samples, count}});
    return v.empty() ? std::string{} : std::move(v[0]);
}

} // namespace ais
