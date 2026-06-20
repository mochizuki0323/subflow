#pragma once
// Minimal self-contained logger for the standalone server. Kept separate from
// the desktop app's logger so this project has no dependency on src/backend.
#include <cstdio>
#include <string>

// windows.h defines ERROR as a macro; never let it break this header.
#ifdef ERROR
#undef ERROR
#endif

namespace ais {
inline void log_line(const char* level, const std::string& message) {
    std::fprintf(stderr, "[%s] %s\n", level, message.c_str());
    std::fflush(stderr);
}
}  // namespace ais

#define LOG_DEBUG(msg) ::ais::log_line("DEBUG", (msg))
#define LOG_INFO(msg)  ::ais::log_line("INFO",  (msg))
#define LOG_WARN(msg)  ::ais::log_line("WARN",  (msg))
#define LOG_ERROR(msg) ::ais::log_line("ERROR", (msg))
