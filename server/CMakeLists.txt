# Standalone Parakeet inference server (Linux x64).
#
# This is a separate deliverable from the SubFlow desktop app. It reuses only the
# repo's vendored third-party libraries under ../extern (sherpa-onnx, uWebSockets,
# nlohmann) — it has no dependency on src/backend. Build with ./build.sh.
cmake_minimum_required(VERSION 3.22)
project(subflow_parakeet_server LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)

find_package(Threads REQUIRED)

# sherpa-onnx: reuse the repo's module, pointed at the repo's extern/ tree.
set(SHERPA_ONNX_ROOT "${REPO_ROOT}/extern/sherpa-onnx")
include("${REPO_ROOT}/cmake/SherpaOnnx.cmake")

# uSockets (Linux epoll, no TLS) built from the vendored uWebSockets.
set(USOCKETS_DIR "${REPO_ROOT}/extern/uWebSockets/uSockets")
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

add_executable(subflow-parakeet-server
    src/server_main.cpp
    src/parakeet_model.cpp
    src/decode_scheduler.cpp
    src/parakeet_session.cpp
    src/model_registry.cpp
    src/parakeet_ws_server.cpp
)

set_target_properties(subflow-parakeet-server PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)

target_include_directories(subflow-parakeet-server PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${REPO_ROOT}/extern/uWebSockets/src
    ${REPO_ROOT}/extern/uWebSockets/uSockets/src
    ${REPO_ROOT}/extern/nlohmann
)

target_link_libraries(subflow-parakeet-server PRIVATE
    uSockets
    Threads::Threads
    sherpa_onnx::c_api
)

target_compile_definitions(subflow-parakeet-server PRIVATE LIBUS_NO_SSL UWS_NO_ZLIB)

install(TARGETS subflow-parakeet-server RUNTIME DESTINATION bin)
