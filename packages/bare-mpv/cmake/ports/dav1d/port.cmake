include_guard(GLOBAL)

set(dav1d_args
  -Denable_tests=false
  -Denable_tools=false
)

# Enable PIC for static libraries on Linux (required for linking into shared objects)
if(LINUX)
  list(APPEND dav1d_args -Db_staticpic=true)
endif()

declare_port(
  "git:code.videolan.org/videolan/dav1d#1.5.1"
  dav1d
  MESON
  BYPRODUCTS lib/libdav1d.a
  ARGS
    ${dav1d_args}
)

add_library(dav1d STATIC IMPORTED GLOBAL)

add_dependencies(dav1d ${dav1d})

set_target_properties(
  dav1d
  PROPERTIES
  IMPORTED_LOCATION "${dav1d_PREFIX}/lib/libdav1d.a"
)

file(MAKE_DIRECTORY "${dav1d_PREFIX}/include")

target_include_directories(
  dav1d
  INTERFACE "${dav1d_PREFIX}/include"
)
