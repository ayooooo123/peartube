if(NOT DEFINED MPV_SOURCE_DIR)
  message(FATAL_ERROR "MPV_SOURCE_DIR is required")
endif()

if(NOT DEFINED MPV_SOURCE_COPY)
  message(FATAL_ERROR "MPV_SOURCE_COPY is required")
endif()

get_filename_component(mpv_copy_parent "${MPV_SOURCE_COPY}" DIRECTORY)

file(REMOVE_RECURSE "${MPV_SOURCE_COPY}")
file(MAKE_DIRECTORY "${mpv_copy_parent}")
file(COPY "${MPV_SOURCE_DIR}" DESTINATION "${mpv_copy_parent}")
