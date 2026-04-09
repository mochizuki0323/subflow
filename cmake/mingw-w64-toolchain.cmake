# Cross-compile Windows x64 binaries from Linux using MinGW-w64.
# Usage:
#   cmake -B build-mingw -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-w64-toolchain.cmake \
#         -DMINGW_SYSROOT=/usr/x86_64-w64-mingw32/sys-root/mingw
#
# Override sysroot if your distro lays out files differently, or set OPENSSL_ROOT_DIR
# to the same tree so FindOpenSSL locates mingw OpenSSL.

if(NOT DEFINED MINGW_SYSROOT)
    if(EXISTS "/usr/x86_64-w64-mingw32/sys-root/mingw")
        set(MINGW_SYSROOT "/usr/x86_64-w64-mingw32/sys-root/mingw")
    elseif(EXISTS "/usr/x86_64-w64-mingw32")
        set(MINGW_SYSROOT "/usr/x86_64-w64-mingw32")
    else()
        message(FATAL_ERROR "MINGW_SYSROOT not set and no default sysroot found. "
            "Install mingw64 toolchain + OpenSSL (e.g. Fedora: mingw64-gcc-c++ mingw64-openssl) "
            "and pass -DMINGW_SYSROOT=... pointing at the tree that contains include/openssl and lib/.")
    endif()
endif()

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR AMD64)

set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++)
set(CMAKE_RC_COMPILER x86_64-w64-mingw32-windres)

set(CMAKE_FIND_ROOT_PATH "${MINGW_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)

list(PREPEND CMAKE_PREFIX_PATH "${MINGW_SYSROOT}")

# Avoid try-compile executables for the host when cross-compiling.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
