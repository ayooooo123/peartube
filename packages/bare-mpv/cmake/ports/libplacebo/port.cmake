include_guard(GLOBAL)

set(libplacebo_args
  -Dvulkan=disabled
  -Dvk-proc-addr=disabled
  -Dglslang=disabled
  -Dshaderc=disabled
  -Dlcms=disabled
  -Ddovi=disabled
  -Dlibdovi=disabled
  -Ddemos=false
  -Dtests=false
  -Dbench=false
  -Dfuzz=false
  -Dunwind=disabled
  -Dxxhash=disabled
  -Ddebug-abort=false
)

# Enable PIC for static libraries on Linux (required for linking into shared objects)
if(LINUX)
  list(APPEND libplacebo_args -Db_staticpic=true)
endif()

declare_port(
  "git:code.videolan.org/videolan/libplacebo#master"
  libplacebo
  MESON
  BYPRODUCTS
    lib/libplacebo.a
  ARGS
    ${libplacebo_args}
)

add_library(placebo STATIC IMPORTED GLOBAL)

add_dependencies(placebo ${libplacebo})

set(libplacebo_lib "${libplacebo_PREFIX}/lib/${CMAKE_STATIC_LIBRARY_PREFIX}placebo${CMAKE_STATIC_LIBRARY_SUFFIX}")

set_target_properties(
  placebo
  PROPERTIES
  IMPORTED_LOCATION "${libplacebo_lib}"
)

file(MAKE_DIRECTORY "${libplacebo_PREFIX}/include")

target_include_directories(
  placebo
  INTERFACE "${libplacebo_PREFIX}/include"
)
