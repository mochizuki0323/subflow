cmake_minimum_required(VERSION 3.22.1)
project(subflow LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(WIN32)
    include(FetchContent)
    set(LIBUV_BUILD_SHARED OFF CACHE BOOL "" FORCE)
    set(LIBUV_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(
        libuv
        GIT_REPOSITORY https://github.com/libuv/libuv.git
        GIT_TAG v1.48.0
    )
    FetchContent_MakeAvailable(libuv)
endif()

# Backend executable
add_subdirectory(src/backend)
