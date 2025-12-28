/**
 * bare-mpv - Bare native addon for libmpv video playback
 * Enables universal codec support (AC3, DTS, etc.) on Pear desktop
 */

#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <vector>
#include <string>

#include <bare.h>
#include <js.h>

#include <mpv/client.h>
#include <mpv/render.h>

// Handle wrapper for mpv_handle
typedef struct {
  mpv_handle *mpv;
} bare_mpv_handle_t;

// Handle wrapper for mpv_render_context
typedef struct {
  mpv_render_context *ctx;
  int width;
  int height;
  uint8_t *buffer;  // RGBA pixel buffer
} bare_mpv_render_t;

// Create mpv instance
static js_value_t *
bare_mpv_create(js_env_t *env, js_callback_info_t *info) {
  int err;

  mpv_handle *mpv = mpv_create();
  if (!mpv) {
    js_throw_error(env, NULL, "Failed to create mpv instance");
    return NULL;
  }

  // Create external arraybuffer to hold handle
  js_value_t *result;
  bare_mpv_handle_t *handle;
  err = js_create_arraybuffer(env, sizeof(bare_mpv_handle_t), (void**)&handle, &result);
  if (err != 0) {
    mpv_destroy(mpv);
    return NULL;
  }

  handle->mpv = mpv;
  return result;
}

// Initialize mpv instance
static js_value_t *
bare_mpv_initialize(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  if (err != 0) return NULL;

  // Get handle from arraybuffer
  bare_mpv_handle_t *handle;
  size_t len;
  err = js_get_arraybuffer_info(env, argv[0], (void**)&handle, &len);
  if (err != 0) return NULL;

  // Set some default options for embedded playback
  mpv_set_option_string(handle->mpv, "vo", "libmpv");  // Use libmpv render API
  mpv_set_option_string(handle->mpv, "hwdec", "auto"); // Use hardware decoding
  mpv_set_option_string(handle->mpv, "keep-open", "yes"); // Don't close on EOF

  int status = mpv_initialize(handle->mpv);

  js_value_t *result;
  js_create_int32(env, status, &result);
  return result;
}

// Destroy mpv instance
static js_value_t *
bare_mpv_destroy(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  if (err != 0) return NULL;

  bare_mpv_handle_t *handle;
  size_t len;
  err = js_get_arraybuffer_info(env, argv[0], (void**)&handle, &len);
  if (err != 0) return NULL;

  if (handle->mpv) {
    mpv_terminate_destroy(handle->mpv);
    handle->mpv = NULL;
  }

  return NULL;
}

// Execute mpv command (e.g., loadfile, seek, etc.)
static js_value_t *
bare_mpv_command(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  if (err != 0) return NULL;

  // Get handle
  bare_mpv_handle_t *handle;
  size_t len;
  err = js_get_arraybuffer_info(env, argv[0], (void**)&handle, &len);
  if (err != 0) return NULL;

  // Get command array
  uint32_t cmd_len;
  err = js_get_array_length(env, argv[1], &cmd_len);
  if (err != 0) return NULL;

  // Build command array for mpv
  std::vector<const char*> cmd_args(cmd_len + 1);
  std::vector<std::string> cmd_strings(cmd_len);

  for (uint32_t i = 0; i < cmd_len; i++) {
    js_value_t *elem;
    js_get_element(env, argv[1], i, &elem);

    size_t str_len;
    js_get_value_string_utf8(env, elem, NULL, 0, &str_len);
    cmd_strings[i].resize(str_len + 1);
    js_get_value_string_utf8(env, elem, (utf8_t*)&cmd_strings[i][0], str_len + 1, NULL);
    cmd_args[i] = cmd_strings[i].c_str();
  }
  cmd_args[cmd_len] = NULL;

  int status = mpv_command(handle->mpv, cmd_args.data());

  js_value_t *result;
  js_create_int32(env, status, &result);
  return result;
}

// Get property (returns double for numeric, string for string properties)
static js_value_t *
bare_mpv_get_property(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  if (err != 0) return NULL;

  bare_mpv_handle_t *handle;
  size_t len;
  err = js_get_arraybuffer_info(env, argv[0], (void**)&handle, &len);
  if (err != 0) return NULL;

  // Get property name
  size_t name_len;
  js_get_value_string_utf8(env, argv[1], NULL, 0, &name_len);
  std::string name(name_len + 1, '\0');
  js_get_value_string_utf8(env, argv[1], (utf8_t*)&name[0], name_len + 1, NULL);

  // Try to get as double first (common for time-pos, duration, etc.)
  double value;
  int status = mpv_get_property(handle->mpv, name.c_str(), MPV_FORMAT_DOUBLE, &value);

  if (status >= 0) {
    js_value_t *result;
    js_create_double(env, value, &result);
    return result;
  }

  // Try as flag (bool)
  int flag;
  status = mpv_get_property(handle->mpv, name.c_str(), MPV_FORMAT_FLAG, &flag);
  if (status >= 0) {
    js_value_t *result;
    js_get_boolean(env, flag != 0, &result);
    return result;
  }

  // Try as string
  char *str = NULL;
  status = mpv_get_property(handle->mpv, name.c_str(), MPV_FORMAT_STRING, &str);
  if (status >= 0 && str) {
    js_value_t *result;
    js_create_string_utf8(env, (const utf8_t*)str, strlen(str), &result);
    mpv_free(str);
    return result;
  }

  // Return undefined if property not available
  js_value_t *undefined;
  js_get_undefined(env, &undefined);
  return undefined;
}

// Set property
static js_value_t *
bare_mpv_set_property(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  if (err != 0) return NULL;

  bare_mpv_handle_t *handle;
  size_t len;
  err = js_get_arraybuffer_info(env, argv[0], (void**)&handle, &len);
  if (err != 0) return NULL;

  // Get property name
  size_t name_len;
  js_get_value_string_utf8(env, argv[1], NULL, 0, &name_len);
  std::string name(name_len + 1, '\0');
  js_get_value_string_utf8(env, argv[1], (utf8_t*)&name[0], name_len + 1, NULL);

  // Check value type and set accordingly
  js_value_type_t value_type;
  js_typeof(env, argv[2], &value_type);

  int status = -1;

  if (value_type == js_number) {
    double value;
    js_get_value_double(env, argv[2], &value);
    status = mpv_set_property(handle->mpv, name.c_str(), MPV_FORMAT_DOUBLE, &value);
  } else if (value_type == js_boolean) {
    bool value;
    js_get_value_bool(env, argv[2], &value);
    int flag = value ? 1 : 0;
    status = mpv_set_property(handle->mpv, name.c_str(), MPV_FORMAT_FLAG, &flag);
  } else if (value_type == js_string) {
    size_t str_len;
    js_get_value_string_utf8(env, argv[2], NULL, 0, &str_len);
    std::string str(str_len + 1, '\0');
    js_get_value_string_utf8(env, argv[2], (utf8_t*)&str[0], str_len + 1, NULL);
    status = mpv_set_property_string(handle->mpv, name.c_str(), str.c_str());
  }

  js_value_t *result;
  js_create_int32(env, status, &result);
  return result;
}

// Create software render context
static js_value_t *
bare_mpv_render_create(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  if (err != 0) return NULL;

  bare_mpv_handle_t *mpv_handle;
  size_t len;
  err = js_get_arraybuffer_info(env, argv[0], (void**)&mpv_handle, &len);
  if (err != 0) return NULL;

  int32_t width, height;
  js_get_value_int32(env, argv[1], &width);
  js_get_value_int32(env, argv[2], &height);

  // Create render context with software renderer
  mpv_render_param params[] = {
    {MPV_RENDER_PARAM_API_TYPE, (void*)MPV_RENDER_API_TYPE_SW},
    {MPV_RENDER_PARAM_INVALID, NULL}
  };

  mpv_render_context *render_ctx = NULL;
  int status = mpv_render_context_create(&render_ctx, mpv_handle->mpv, params);

  if (status < 0) {
    js_throw_error(env, NULL, "Failed to create render context");
    return NULL;
  }

  // Create handle with buffer for rendered frames
  js_value_t *result;
  bare_mpv_render_t *handle;
  err = js_create_arraybuffer(env, sizeof(bare_mpv_render_t), (void**)&handle, &result);
  if (err != 0) {
    mpv_render_context_free(render_ctx);
    return NULL;
  }

  handle->ctx = render_ctx;
  handle->width = width;
  handle->height = height;
  handle->buffer = (uint8_t*)malloc(width * height * 4);  // RGBA

  return result;
}

// Render frame to buffer
static js_value_t *
bare_mpv_render_frame(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  if (err != 0) return NULL;

  bare_mpv_render_t *handle;
  size_t len;
  err = js_get_arraybuffer_info(env, argv[0], (void**)&handle, &len);
  if (err != 0) return NULL;

  if (!handle->ctx || !handle->buffer) {
    js_value_t *null_val;
    js_get_null(env, &null_val);
    return null_val;
  }

  int w = handle->width;
  int h = handle->height;

  // Set up render parameters for software rendering
  int pitch = w * 4;  // RGBA stride
  int size[2] = {w, h};

  mpv_render_param render_params[] = {
    {MPV_RENDER_PARAM_SW_SIZE, size},
    {MPV_RENDER_PARAM_SW_FORMAT, (void*)"rgba"},
    {MPV_RENDER_PARAM_SW_STRIDE, &pitch},
    {MPV_RENDER_PARAM_SW_POINTER, handle->buffer},
    {MPV_RENDER_PARAM_INVALID, NULL}
  };

  int status = mpv_render_context_render(handle->ctx, render_params);

  if (status < 0) {
    js_value_t *null_val;
    js_get_null(env, &null_val);
    return null_val;
  }

  // Create Uint8Array view of the buffer
  size_t buffer_size = w * h * 4;
  js_value_t *arraybuffer;
  void *data;
  err = js_create_arraybuffer(env, buffer_size, &data, &arraybuffer);
  if (err != 0) return NULL;

  memcpy(data, handle->buffer, buffer_size);

  js_value_t *uint8array;
  err = js_create_typedarray(env, js_uint8array, buffer_size, arraybuffer, 0, &uint8array);
  if (err != 0) return arraybuffer;

  return uint8array;
}

// Free render context
static js_value_t *
bare_mpv_render_free(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  if (err != 0) return NULL;

  bare_mpv_render_t *handle;
  size_t len;
  err = js_get_arraybuffer_info(env, argv[0], (void**)&handle, &len);
  if (err != 0) return NULL;

  if (handle->ctx) {
    mpv_render_context_free(handle->ctx);
    handle->ctx = NULL;
  }

  if (handle->buffer) {
    free(handle->buffer);
    handle->buffer = NULL;
  }

  return NULL;
}

// Check if new frame is available
static js_value_t *
bare_mpv_render_update(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  if (err != 0) return NULL;

  bare_mpv_render_t *handle;
  size_t len;
  err = js_get_arraybuffer_info(env, argv[0], (void**)&handle, &len);
  if (err != 0) return NULL;

  uint64_t flags = mpv_render_context_update(handle->ctx);
  bool needs_render = (flags & MPV_RENDER_UPDATE_FRAME) != 0;

  js_value_t *result;
  js_get_boolean(env, needs_render, &result);
  return result;
}

// Module exports
static js_value_t *
bare_mpv_exports(js_env_t *env, js_value_t *exports) {
  int err;

#define EXPORT_FUNCTION(name, fn) \
  do { \
    js_value_t *func; \
    err = js_create_function(env, #name, -1, fn, NULL, &func); \
    if (err == 0) js_set_named_property(env, exports, #name, func); \
  } while(0)

  EXPORT_FUNCTION(create, bare_mpv_create);
  EXPORT_FUNCTION(initialize, bare_mpv_initialize);
  EXPORT_FUNCTION(destroy, bare_mpv_destroy);
  EXPORT_FUNCTION(command, bare_mpv_command);
  EXPORT_FUNCTION(getProperty, bare_mpv_get_property);
  EXPORT_FUNCTION(setProperty, bare_mpv_set_property);
  EXPORT_FUNCTION(renderCreate, bare_mpv_render_create);
  EXPORT_FUNCTION(renderFrame, bare_mpv_render_frame);
  EXPORT_FUNCTION(renderFree, bare_mpv_render_free);
  EXPORT_FUNCTION(renderUpdate, bare_mpv_render_update);

#undef EXPORT_FUNCTION

  return exports;
}

BARE_MODULE(bare_mpv, bare_mpv_exports)
