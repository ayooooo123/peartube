cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-ports REQUIRED PATHS node_modules/cmake-ports)
find_package(cmake-meson REQUIRED PATHS node_modules/cmake-meson)

project(bare_mpv C CXX)

set(MPV_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor/mpv")
if(NOT EXISTS "${MPV_SOURCE_DIR}/meson.build")
  message(FATAL_ERROR "mpv submodule missing. Run: git submodule update --init --recursive packages/bare-mpv/vendor/mpv")
endif()

set(ffmpeg_features dav1d)

find_port(freetype)
find_port(libass)
find_port(libplacebo)
find_port(ffmpeg FEATURES ${ffmpeg_features})

if(LINUX)
  find_port(libva)
  find_port(libdrm)
endif()

include(ExternalProject)

meson_cross_file(cross_file)
meson_buildtype(buildtype)

set(mpv_prefix "${CMAKE_CURRENT_BINARY_DIR}/_ports/mpv")
set(mpv_source_copy "${mpv_prefix}/src/mpv")
set(mpv_build_dir "${mpv_prefix}/build")
set(mpv_lib_name "${CMAKE_STATIC_LIBRARY_PREFIX}mpv${CMAKE_STATIC_LIBRARY_SUFFIX}")
set(mpv_lib_path "${mpv_prefix}/lib/${mpv_lib_name}")

file(MAKE_DIRECTORY "${mpv_prefix}")
file(MAKE_DIRECTORY "${mpv_build_dir}")
file(GENERATE OUTPUT "${mpv_build_dir}/cross-file.txt" CONTENT "${cross_file}")

if(CMAKE_HOST_WIN32)
  find_path(
    msys2
    NAMES msys2.exe
    PATHS "C:/tools/msys64"
    REQUIRED
  )

  find_program(
    pkg-config
    NAMES pkg-config
    PATHS "${msys2}/usr/bin"
    REQUIRED
    NO_DEFAULT_PATH
  )
else()
  find_program(
    pkg-config
    NAMES pkg-config
    REQUIRED
  )
endif()

set(pkg_config_path
  "${ffmpeg_PREFIX}/lib/pkgconfig"
  "${libass_PREFIX}/lib/pkgconfig"
  "${libplacebo_PREFIX}/lib/pkgconfig"
  "${freetype_PREFIX}/lib/pkgconfig"
)

if(LINUX)
  list(APPEND pkg_config_path
    "${libva_PREFIX}/lib/pkgconfig"
    "${libdrm_PREFIX}/lib/pkgconfig"
  )
endif()

list(REMOVE_DUPLICATES pkg_config_path)

set(path_env)
foreach(part "$ENV{PATH}")
  cmake_path(NORMAL_PATH part)
  list(APPEND path_env "${part}")
endforeach()

if(CMAKE_HOST_WIN32)
  list(APPEND path_env "${msys2}/usr/bin")
  list(TRANSFORM path_env REPLACE "([A-Z]):" "/\\1")
  list(TRANSFORM pkg_config_path REPLACE "([A-Z]):" "/\\1")
endif()

list(REMOVE_DUPLICATES path_env)
list(JOIN path_env ":" path_env)
list(JOIN pkg_config_path ":" pkg_config_path)

set(env
  "PATH=${path_env}"
  "PKG_CONFIG=${pkg-config}"
  "PKG_CONFIG_PATH=${pkg_config_path}"
)

if(CMAKE_HOST_WIN32)
  find_program(
    meson
    NAMES meson.cmd meson
    PATHS "C:/Program Files/Meson"
    REQUIRED
  )
else()
  find_program(
    meson
    NAMES meson
    REQUIRED
  )
endif()

set(mpv_meson_args
  "${mpv_source_copy}"
  "${mpv_build_dir}"
  --buildtype ${buildtype}
  --default-library static
  --prefix "${mpv_prefix}"
  --cross-file "${mpv_build_dir}/cross-file.txt"

  -Dlibmpv=true
  -Dcplayer=false
  -Dtests=false
  -Dfuzzers=false

  -Dcocoa=disabled
  -Dgl-cocoa=disabled
  -Dmacos-cocoa-cb=disabled

  # Note: libplacebo is now a required dependency in mpv, not an option
  -Dvulkan=disabled
  -Dshaderc=disabled
  -Dspirv-cross=disabled

  -Djavascript=disabled
  -Dlua=disabled
  -Dlibarchive=disabled
  -Duchardet=disabled
  -Dlcms2=disabled
  -Dzimg=disabled
  -Dlibavdevice=disabled
  -Dsubrandr=disabled

  -Dcdda=disabled
  -Ddvdnav=disabled
  -Dlibbluray=disabled
  -Drubberband=disabled
  -Dvapoursynth=disabled

  -Dopenal=disabled
  -Djack=disabled
  -Dsndio=disabled
  -Doss-audio=disabled
  -Dpipewire=disabled
  -Dpulse=disabled
  -Dalsa=enabled
  -Dsdl2-audio=disabled
  -Dsdl2-video=disabled

  -Dmanpage-build=disabled
  -Dhtml-build=disabled
  -Dpdf-build=disabled
  -Dswift-build=disabled
)

# Enable PIC for static libraries on Linux (required for linking into shared objects)
if(LINUX)
  list(APPEND mpv_meson_args -Db_staticpic=true)
endif()

ExternalProject_Add(
  mpv_ext
  PREFIX "${mpv_prefix}"
  SOURCE_DIR "${mpv_source_copy}"
  BINARY_DIR "${mpv_build_dir}"
  DOWNLOAD_COMMAND
    ${CMAKE_COMMAND}
      -DMPV_SOURCE_DIR=${MPV_SOURCE_DIR}
      -DMPV_SOURCE_COPY=${mpv_source_copy}
      -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ports/mpv/copy-source.cmake"
  PATCH_COMMAND ""
  CONFIGURE_COMMAND
    ${CMAKE_COMMAND} -E env ${env} ${meson} setup ${mpv_meson_args}
  BUILD_COMMAND
    ${CMAKE_COMMAND} -E env ${env} ${meson} compile -C "${mpv_build_dir}"
  INSTALL_COMMAND
    ${CMAKE_COMMAND} -E env ${env} ${meson} install -C "${mpv_build_dir}"
  INSTALL_BYPRODUCTS
    "${mpv_lib_path}"
)

# cmake-ports sets *_PREFIX cache variables but doesn't expose target names.
# Extract target names from the PREFIX paths (target = last path component).
cmake_path(GET ffmpeg_PREFIX FILENAME ffmpeg_target)
cmake_path(GET libass_PREFIX FILENAME libass_target)
cmake_path(GET libplacebo_PREFIX FILENAME libplacebo_target)
cmake_path(GET freetype_PREFIX FILENAME freetype_target)

# ExternalProject DEPENDS creates target-level dependencies but doesn't ensure
# the configure step waits for dependencies to be installed first (ninja runs them
# in parallel). Explicitly make mpv configure wait for dependencies' install steps.
ExternalProject_Add_StepDependencies(mpv_ext configure
  ${ffmpeg_target}-install
  ${libass_target}-install
  ${libplacebo_target}-install
  ${freetype_target}-install
)

add_library(mpv STATIC IMPORTED GLOBAL)
add_dependencies(mpv mpv_ext)

set_target_properties(
  mpv
  PROPERTIES
  IMPORTED_LOCATION "${mpv_lib_path}"
)

file(MAKE_DIRECTORY "${mpv_prefix}/include")

target_include_directories(
  mpv
  INTERFACE "${mpv_prefix}/include"
)

add_bare_module(bare_mpv)
add_dependencies(${bare_mpv} mpv_ext)

target_sources(${bare_mpv} PRIVATE binding.cc)

target_include_directories(${bare_mpv} PRIVATE "${mpv_prefix}/include")

target_link_libraries(
  ${bare_mpv}
  PRIVATE
    mpv
    placebo
    ass
    freetype
    avcodec
    avfilter
    avformat
    avutil
    swresample
    swscale
)

if(LINUX)
  target_link_libraries(${bare_mpv} PRIVATE va va-drm drm)
endif()

if(UNIX AND NOT APPLE)
  target_link_libraries(${bare_mpv} PRIVATE m dl)
endif()

find_package(Threads REQUIRED)
target_link_libraries(${bare_mpv} PRIVATE Threads::Threads)

# C++17 for modern features
set_target_properties(${bare_mpv} PROPERTIES CXX_STANDARD 17)
