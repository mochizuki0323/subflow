#pragma once
// OpenSSL on MinGW pulls in windows.h, which #defines ERROR. Undefine so our code can use
// identifiers like msg::ERR / Logger::Level::ERR without the macro breaking parsing.
#if defined(_WIN32) && defined(ERROR)
#undef ERROR
#endif
