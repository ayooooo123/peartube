include_guard(GLOBAL)

find_port(freetype)

set(env)
set(path)
set(pkg_config_path "${freetype_PREFIX}/lib/pkgconfig")

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

  list(APPEND path "${msys2}/usr/bin")
else()
  find_program(
    pkg-config
    NAMES pkg-config
    REQUIRED
  )
endif()

foreach(part "$ENV{PATH}")
  cmake_path(NORMAL_PATH part)

  list(APPEND path "${part}")
endforeach()

list(REMOVE_DUPLICATES path)

if(CMAKE_HOST_WIN32)
  list(TRANSFORM path REPLACE "([A-Z]):" "/\\1")
  list(TRANSFORM pkg_config_path REPLACE "([A-Z]):" "/\\1")
endif()

list(JOIN path ":" path)

list(APPEND env
  "PATH=${path}"
  "PKG_CONFIG=${pkg-config}"
  "PKG_CONFIG_PATH=${pkg_config_path}"
)

set(libass_args
  --disable-shared
  --enable-static
  --with-pic
  --disable-fontconfig
  --disable-fribidi
  --disable-harfbuzz
)

# On Linux, there's no system font provider (DirectWrite on Windows, CoreText on macOS)
# so we need to explicitly disable the requirement
if(LINUX)
  list(APPEND libass_args --disable-require-system-font-provider)
endif()

declare_port(
  "https://github.com/libass/libass/releases/download/0.17.1/libass-0.17.1.tar.xz"
  libass
  AUTOTOOLS
  DEPENDS freetype
  BYPRODUCTS
    lib/libass.a
  ARGS
    ${libass_args}
  ENV ${env}
)

add_library(ass STATIC IMPORTED GLOBAL)

add_dependencies(ass ${libass})

set(libass_lib "${libass_PREFIX}/lib/libass.a")

set_target_properties(
  ass
  PROPERTIES
  IMPORTED_LOCATION "${libass_lib}"
)

file(MAKE_DIRECTORY "${libass_PREFIX}/include")

target_include_directories(
  ass
  INTERFACE "${libass_PREFIX}/include"
)
