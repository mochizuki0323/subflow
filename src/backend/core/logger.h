#pragma once
#include <string>
#include <functional>
#include <cstdio>
#include <mutex>

// windows.h defines ERROR as a macro; ensure it never breaks this header if included later.
#ifdef ERROR
#undef ERROR
#endif

namespace ais {

class Logger {
public:
    // Use ERR not ERROR — Windows headers #define ERROR
    enum class Level { DEBUG, INFO, WARN, ERR };

    using LogCallback = std::function<void(Level, const std::string&)>;

    static Logger& instance() {
        static Logger logger;
        return logger;
    }

    void set_callback(LogCallback cb) {
        std::lock_guard<std::mutex> lock(mutex_);
        callback_ = std::move(cb);
    }

    void log(Level level, const std::string& message) {
        const char* prefix[] = {"DEBUG", "INFO", "WARN", "ERROR"};
        std::fprintf(stderr, "[%s] %s\n", prefix[static_cast<int>(level)], message.c_str());
        LogCallback cb;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            cb = callback_;
        }
        if (cb) cb(level, message);
    }

    void debug(const std::string& msg) { log(Level::DEBUG, msg); }
    void info(const std::string& msg)  { log(Level::INFO, msg); }
    void warn(const std::string& msg)  { log(Level::WARN, msg); }
    void error(const std::string& msg) { log(Level::ERR, msg); }

private:
    Logger() = default;
    std::mutex mutex_;
    LogCallback callback_;
};

#define LOG_DEBUG(msg) ais::Logger::instance().debug(msg)
#define LOG_INFO(msg)  ais::Logger::instance().info(msg)
#define LOG_WARN(msg)  ais::Logger::instance().warn(msg)
#define LOG_ERROR(msg) ais::Logger::instance().error(msg)

} // namespace ais
