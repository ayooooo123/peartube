cmake_minimum_required(VERSION 3.22.1)

project(NitroVLC)

add_library(NitroVLC SHARED
  cpp-adapter.cpp
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/NitroVLC+autolinking.cmake)
