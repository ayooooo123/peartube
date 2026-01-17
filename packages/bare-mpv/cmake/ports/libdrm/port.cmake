include_guard(GLOBAL)

set(libdrm_args
  -Dcairo-tests=disabled
  -Dman-pages=disabled
  -Dvalgrind=disabled
  -Dinstall-test-programs=false
  -Dudev=true
)

# Enable PIC for static libraries on Linux (required for linking into shared objects)
if(LINUX)
  list(APPEND libdrm_args -Db_staticpic=true)
endif()

declare_port(
  "git:gitlab.freedesktop.org/mesa/drm#libdrm-2.4.128"
  libdrm
  MESON
  BYPRODUCTS
    lib/libdrm.a
  ARGS
    ${libdrm_args}
)

add_library(drm STATIC IMPORTED GLOBAL)

add_dependencies(drm ${libdrm})

set_target_properties(
  drm
  PROPERTIES
  IMPORTED_LOCATION "${libdrm_PREFIX}/lib/libdrm.a"
)

file(MAKE_DIRECTORY "${libdrm_PREFIX}/include")

target_include_directories(
  drm
  INTERFACE "${libdrm_PREFIX}/include"
)
