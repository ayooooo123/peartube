cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

project(bare_mpv C CXX)

# Find system libmpv
if(APPLE)
  set(MPV_LIBRARY "/opt/homebrew/lib/libmpv.dylib")
  set(MPV_INCLUDE_DIR "/opt/homebrew/include")
elseif(UNIX)
  find_library(MPV_LIBRARY mpv REQUIRED)
  find_path(MPV_INCLUDE_DIR mpv/client.h REQUIRED)
endif()

add_bare_module(bare_mpv)

target_sources(${bare_mpv} PRIVATE binding.cc)

target_include_directories(${bare_mpv} PRIVATE ${MPV_INCLUDE_DIR})
target_link_libraries(${bare_mpv} PRIVATE ${MPV_LIBRARY})

# C++17 for modern features
set_target_properties(${bare_mpv} PROPERTIES CXX_STANDARD 17)
