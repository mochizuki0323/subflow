find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)

set(USOCKETS_DIR ${CMAKE_SOURCE_DIR}/extern/uWebSockets/uSockets)

if(WIN32)
    add_library(uSockets STATIC
        ${USOCKETS_DIR}/src/bsd.c
        ${USOCKETS_DIR}/src/context.c
        ${USOCKETS_DIR}/src/loop.c
        ${USOCKETS_DIR}/src/socket.c
        ${USOCKETS_DIR}/src/udp.c
        ${USOCKETS_DIR}/src/eventing/libuv.c
        ${USOCKETS_DIR}/src/crypto/sni_tree.cpp
    )
    target_include_directories(uSockets PUBLIC ${USOCKETS_DIR}/src)
    target_compile_definitions(uSockets PUBLIC LIBUS_NO_SSL)
    target_link_libraries(uSockets PUBLIC uv_a ws2_32 userenv psapi iphlpapi dbghelp)
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(PIPEWIRE REQUIRED IMPORTED_TARGET libpipewire-0.3)
    add_library(uSockets STATIC
        ${USOCKETS_DIR}/src/bsd.c
        ${USOCKETS_DIR}/src/context.c
        ${USOCKETS_DIR}/src/loop.c
        ${USOCKETS_DIR}/src/socket.c
        ${USOCKETS_DIR}/src/udp.c
        ${USOCKETS_DIR}/src/eventing/epoll_kqueue.c
        ${USOCKETS_DIR}/src/crypto/sni_tree.cpp
    )
    target_include_directories(uSockets PUBLIC ${USOCKETS_DIR}/src)
    target_compile_definitions(uSockets PUBLIC LIBUS_NO_SSL)
    target_link_libraries(uSockets PRIVATE PkgConfig::PIPEWIRE)
endif()

# ── Networking: Boost.Beast WebSocket + HTTP clients ──────────────────────────
# Boost (Beast + Asio + System) is header-only, so the same vendored headers
# serve both the native build and the MinGW cross-compile. The Boost dependency
# is confined to subflow_net's translation units; its public headers
# (net/ws_client.h, net/http_client.h) are Boost-free.
set(BOOST_INCLUDE_DIR ${CMAKE_SOURCE_DIR}/extern/boost/include)
if(NOT EXISTS "${BOOST_INCLUDE_DIR}/boost/beast.hpp")
    message(FATAL_ERROR
        "Boost headers not found.\n"
        "Run: ./scripts/setup-deps.sh\n"
        "Expected: ${BOOST_INCLUDE_DIR}/boost/beast.hpp")
endif()

add_library(subflow_net STATIC
    net/beast_ws_client.cpp
    net/http_client.cpp
)
target_include_directories(subflow_net
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}
    PRIVATE ${BOOST_INCLUDE_DIR} ${OPENSSL_INCLUDE_DIR}
)
target_link_libraries(subflow_net PUBLIC OpenSSL::SSL OpenSSL::Crypto Threads::Threads)
target_compile_definitions(subflow_net PRIVATE BOOST_ASIO_NO_DEPRECATED)
if(WIN32)
    target_compile_definitions(subflow_net PRIVATE _WIN32_WINNT=0x0A00 WIN32_LEAN_AND_MEAN)
    target_link_libraries(subflow_net PUBLIC ws2_32 mswsock crypt32 bcrypt)
endif()

# Backend executable
set(BACKEND_SOURCES
    main.cpp
    core/engine.cpp
    audio/audio_buffer.cpp
    audio/audio_source.cpp
    audio/create_audio_source.cpp
    audio/denoiser.cpp
    transcriber/deepgram_transcriber.cpp
    transcriber/gladia_transcriber.cpp
    transcriber/parakeet_transcriber.cpp
    transcriber/remote_parakeet_transcriber.cpp
    ipc/ws_server.cpp
)

if(WIN32)
    list(APPEND BACKEND_SOURCES
        audio/wasapi/wasapi_audio_source.cpp
    )
else()
    list(APPEND BACKEND_SOURCES
        audio/pipewire/pw_audio_source.cpp
        audio/pipewire/pw_node_enumerator.cpp
    )
endif()

add_executable(subflow-backend ${BACKEND_SOURCES})

set_target_properties(subflow-backend PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
    RUNTIME_OUTPUT_DIRECTORY_DEBUG ${CMAKE_BINARY_DIR}/bin
    RUNTIME_OUTPUT_DIRECTORY_RELEASE ${CMAKE_BINARY_DIR}/bin
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL ${CMAKE_BINARY_DIR}/bin
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO ${CMAKE_BINARY_DIR}/bin
)

target_include_directories(subflow-backend PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}/extern/uWebSockets/src
    ${CMAKE_SOURCE_DIR}/extern/uWebSockets/uSockets/src
    ${CMAKE_SOURCE_DIR}/extern/nlohmann
    ${OPENSSL_INCLUDE_DIR}
)

target_link_libraries(subflow-backend PRIVATE
    subflow_net
    OpenSSL::SSL
    OpenSSL::Crypto
    uSockets
    Threads::Threads
    sherpa_onnx::c_api
)

if(WIN32)
    # ole32/propsys/uuid/avrt: WASAPI/COM (MSVC often picks these up via #pragma; MinGW needs explicit libs)
    target_link_libraries(subflow-backend PRIVATE ws2_32 crypt32 ole32 propsys uuid avrt mmdevapi)
    if(MINGW)
        # Avoid runtime crashes from missing MinGW DLLs on target Windows hosts.
        # Exit code 0xC0000135 indicates STATUS_DLL_NOT_FOUND at process startup.
        target_link_options(subflow-backend PRIVATE -static -static-libgcc -static-libstdc++)
        # WASAPI/ksmedia GUIDs: libksguid.a.
        find_package(ZLIB REQUIRED)
        target_link_libraries(subflow-backend PRIVATE ksguid ZLIB::ZLIB)
        find_library(_AIS_MINGW_PATHCCH pathcch NAMES pathcch libpathcch
            PATHS "${CMAKE_FIND_ROOT_PATH}/lib" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
        if(_AIS_MINGW_PATHCCH)
            target_link_libraries(subflow-backend PRIVATE ${_AIS_MINGW_PATHCCH})
        else()
            find_library(_AIS_MINGW_KB kernelbase NAMES kernelbase libkernelbase
                PATHS "${CMAKE_FIND_ROOT_PATH}/lib" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
            if(_AIS_MINGW_KB)
                target_link_libraries(subflow-backend PRIVATE ${_AIS_MINGW_KB})
            else()
                target_link_libraries(subflow-backend PRIVATE pathcch)
            endif()
        endif()
    endif()
else()
    target_link_libraries(subflow-backend PRIVATE PkgConfig::PIPEWIRE)
endif()

target_compile_definitions(subflow-backend PRIVATE
    LIBUS_NO_SSL
    UWS_NO_ZLIB
)

install(TARGETS subflow-backend RUNTIME DESTINATION bin)

# The standalone Parakeet inference server lives in its own project under
# server/ (built via server/build.sh) — it is a separate deliverable and must
# not be coupled to the desktop app backend.
