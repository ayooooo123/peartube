#include <assert.h>
#include <bare.h>
#include <js.h>
#include <openssl/base.h>
#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/ssl.h>
#include <stddef.h>
#include <string.h>

typedef struct {
  SSL_CTX *ssl;
  BIO_METHOD *io;

  js_env_t *env;
  js_ref_t *ctx;
} bare_tls_context_t;

typedef struct {
  SSL *ssl;
  BIO *io;
  X509 *certificate;
  EVP_PKEY *key;

  js_env_t *env;
  js_ref_t *ctx;
  js_ref_t *on_read;
  js_ref_t *on_write;
} bare_tls_t;

static int
bare_tls__on_read(BIO *io, char *buffer, int len) {
  if (len == 0) return 0;

  int err;

  BIO_clear_retry_flags(io);

  bare_tls_t *socket = BIO_get_ex_data(io, 0);

  js_env_t *env = socket->env;

  // Create JS-owned buffer instead of wrapping OpenSSL's internal buffer
  // This prevents use-after-free when hardened malloc is enabled
  js_value_t *arraybuffer;
  void *js_buffer;
  err = js_create_arraybuffer(env, len, &js_buffer, &arraybuffer);
  assert(err == 0);

  js_value_t *typedarray;
  err = js_create_typedarray(env, js_uint8array, len, arraybuffer, 0, &typedarray);
  assert(err == 0);

  js_value_t *ctx;
  err = js_get_reference_value(env, socket->ctx, &ctx);
  assert(err == 0);

  js_value_t *on_read;
  err = js_get_reference_value(env, socket->on_read, &on_read);
  assert(err == 0);

  js_value_t *result;
  err = js_call_function(env, ctx, on_read, 1, &typedarray, &result);
  if (err < 0) return -1;

  err = js_get_value_int32(env, result, &len);
  assert(err == 0);

  // Copy data from JS buffer back to OpenSSL's buffer
  if (len > 0) {
    memcpy(buffer, js_buffer, len);
  }

  // No detach needed - JS engine owns and will GC the buffer

  if (len == 0) {
    BIO_set_retry_read(io);

    return -1;
  }

  return len;
}

static int
bare_tls__on_write(BIO *io, const char *buffer, int len) {
  if (len == 0) return 0;

  int err;

  BIO_clear_retry_flags(io);

  bare_tls_t *socket = BIO_get_ex_data(io, 0);

  js_env_t *env = socket->env;

  // Create JS-owned buffer and copy OpenSSL's data into it
  // This prevents use-after-free when hardened malloc is enabled
  js_value_t *arraybuffer;
  void *js_buffer;
  err = js_create_arraybuffer(env, len, &js_buffer, &arraybuffer);
  assert(err == 0);

  // Copy OpenSSL's data to the safe JS-owned buffer
  memcpy(js_buffer, buffer, len);

  js_value_t *typedarray;
  err = js_create_typedarray(env, js_uint8array, len, arraybuffer, 0, &typedarray);
  assert(err == 0);

  js_value_t *ctx;
  err = js_get_reference_value(env, socket->ctx, &ctx);
  assert(err == 0);

  js_value_t *on_write;
  err = js_get_reference_value(env, socket->on_write, &on_write);
  assert(err == 0);

  js_value_t *result;
  err = js_call_function(env, ctx, on_write, 1, &typedarray, &result);
  if (err < 0) return -1;

  err = js_get_value_int32(env, result, &len);
  assert(err == 0);

  // No detach needed - JS engine owns and will GC the buffer

  if (len == 0) {
    BIO_set_retry_write(io);

    return -1;
  }

  return len;
}

static long
bare_tls__on_ctrl(BIO *io, int cmd, long argc, void *argv) {
  switch (cmd) {
  case BIO_CTRL_FLUSH:
    return 1;

  default:
    return 0;
  }
}

static void
bare_tls__on_teardown(void *data) {
  int err;

  bare_tls_context_t *context = (bare_tls_context_t *) data;

  js_env_t *env = context->env;

  SSL_CTX_free(context->ssl);

  BIO_meth_free(context->io);

  err = js_delete_reference(env, context->ctx);
  assert(err == 0);
}

static js_value_t *
bare_tls_context(js_env_t *env, js_callback_info_t *info) {
  int err;

  js_value_t *handle;

  bare_tls_context_t *context;
  err = js_create_arraybuffer(env, sizeof(bare_tls_context_t), (void **) &context, &handle);
  assert(err == 0);

  BIO_METHOD *io = context->io = BIO_meth_new(BIO_get_new_index() | BIO_TYPE_SOURCE_SINK, "callback");

  if (io == NULL) goto err;

  SSL_CTX *ssl = context->ssl = SSL_CTX_new(TLS_method());

  if (ssl == NULL) {
    BIO_meth_free(io);

    goto err;
  }

  BIO_meth_set_read(io, bare_tls__on_read);
  BIO_meth_set_write(io, bare_tls__on_write);
  BIO_meth_set_ctrl(io, bare_tls__on_ctrl);

  err = SSL_CTX_set_ex_data(ssl, 0, (void *) context);
  assert(err == 1);

  err = SSL_CTX_set_min_proto_version(ssl, TLS1_2_VERSION);
  assert(err == 1);

  context->env = env;

  err = js_add_teardown_callback(env, bare_tls__on_teardown, (void *) context);
  assert(err == 0);

  err = js_create_reference(env, handle, 1, &context->ctx);
  assert(err == 0);

  return handle;

err:
  js_throw_error(env, ERR_reason_symbol_name(ERR_peek_last_error()), "Context initialisation failed");
  return NULL;
}

static js_value_t *
bare_tls_init(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 8;
  js_value_t *argv[8];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 8);

  bare_tls_context_t *context;
  err = js_get_arraybuffer_info(env, argv[0], (void **) &context, NULL);
  assert(err == 0);

  js_value_t *handle;

  bare_tls_t *socket;
  err = js_create_arraybuffer(env, sizeof(bare_tls_t), (void **) &socket, &handle);
  assert(err == 0);

  socket->certificate = NULL;
  socket->key = NULL;

  BIO *io = socket->io = BIO_new(context->io);

  if (io == NULL) goto err;

  SSL *ssl = socket->ssl = SSL_new(context->ssl);

  if (io == NULL) {
    BIO_free(io);

    goto err;
  }

  err = BIO_set_ex_data(io, 0, (void *) socket);
  assert(err == 1);

  BIO_set_init(io, true);

  err = SSL_set_ex_data(ssl, 0, (void *) socket);
  assert(err == 1);

  SSL_set_bio(ssl, io, io);

  bool is_server;
  err = js_get_value_bool(env, argv[1], &is_server);
  assert(err == 0);

  if (is_server) SSL_set_accept_state(ssl);
  else SSL_set_connect_state(ssl);

  bool has_cert;
  err = js_is_typedarray(env, argv[2], &has_cert);
  assert(err == 0);

  if (has_cert) {
    char *pem;
    size_t len;
    err = js_get_typedarray_info(env, argv[2], NULL, (void **) &pem, &len, NULL, NULL);
    assert(err == 0);

    BIO *io = BIO_new(BIO_s_mem());
    BIO_write(io, pem, (int) len);

    X509 *certificate = socket->certificate = PEM_read_bio_X509(io, NULL, NULL, NULL);

    BIO_free(io);

    if (certificate == NULL) {
      SSL_free(ssl);

      goto err;
    }

    err = SSL_use_certificate(ssl, certificate);

    if (err == 0) {
      SSL_free(ssl);

      X509_free(certificate);

      goto err;
    }
  }

  bool has_key;
  err = js_is_typedarray(env, argv[3], &has_key);
  assert(err == 0);

  if (has_key) {
    char *pem;
    size_t len;
    err = js_get_typedarray_info(env, argv[3], NULL, (void **) &pem, &len, NULL, NULL);
    assert(err == 0);

    BIO *io = BIO_new(BIO_s_mem());
    BIO_write(io, pem, (int) len);

    EVP_PKEY *key = socket->key = PEM_read_bio_PrivateKey(io, NULL, NULL, NULL);

    BIO_free(io);

    if (key == NULL) {
      SSL_free(ssl);

      goto err;
    }

    int res = SSL_use_PrivateKey(ssl, key);

    if (res == 0) {
      SSL_free(ssl);

      EVP_PKEY_free(key);

      goto err;
    }
  }

  bool has_host;
  err = js_is_string(env, argv[4], &has_host);
  assert(err == 0);

  if (has_host) {
    size_t len;
    err = js_get_value_string_utf8(env, argv[4], NULL, 0, &len);
    assert(err == 0);

    len += 1 /* NULL */;

    utf8_t *host = malloc(len);
    err = js_get_value_string_utf8(env, argv[4], host, len, NULL);
    assert(err == 0);

    err = SSL_set_tlsext_host_name(ssl, (char *) host);
    assert(err == 1);

    free(host);
  }

  socket->env = env;

  err = js_create_reference(env, argv[5], 1, &socket->ctx);
  assert(err == 0);

  err = js_create_reference(env, argv[6], 1, &socket->on_read);
  assert(err == 0);

  err = js_create_reference(env, argv[7], 1, &socket->on_write);
  assert(err == 0);

  return handle;

err:
  js_throw_error(env, ERR_reason_symbol_name(ERR_peek_last_error()), "Socket initialisation failed");
  return NULL;
}

static js_value_t *
bare_tls_destroy(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 1);

  bare_tls_t *socket;
  err = js_get_arraybuffer_info(env, argv[0], (void **) &socket, NULL);
  assert(err == 0);

  SSL_free(socket->ssl);

  if (socket->certificate) X509_free(socket->certificate);

  if (socket->key) EVP_PKEY_free(socket->key);

  err = js_delete_reference(env, socket->on_read);
  assert(err == 0);

  err = js_delete_reference(env, socket->on_write);
  assert(err == 0);

  err = js_delete_reference(env, socket->ctx);
  assert(err == 0);

  return NULL;
}

static js_value_t *
bare_tls_handshake(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 1);

  bare_tls_t *socket;
  err = js_get_arraybuffer_info(env, argv[0], (void **) &socket, NULL);
  assert(err == 0);

  bool done = true;

  err = SSL_do_handshake(socket->ssl);

  if (err <= 0) {
    err = SSL_get_error(socket->ssl, err);

    if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
      done = false;
    } else {
      js_throw_error(env, ERR_reason_symbol_name(ERR_peek_last_error()), "Handshake failed");
      return NULL;
    }
  }

  js_value_t *result;
  err = js_get_boolean(env, done, &result);
  assert(err == 0);

  return result;
}

static js_value_t *
bare_tls_read(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 2);

  bare_tls_t *socket;
  err = js_get_arraybuffer_info(env, argv[0], (void **) &socket, NULL);
  assert(err == 0);

  char *buffer;
  size_t len;
  err = js_get_typedarray_info(env, argv[1], NULL, (void **) &buffer, &len, NULL, NULL);
  assert(err == 0);

  bool retry = false;
  bool eof = false;

  err = SSL_read(socket->ssl, buffer, len);

  if (err <= 0) {
    err = SSL_get_error(socket->ssl, err);

    if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
      retry = true;
    } else if (SSL_get_shutdown(socket->ssl)) {
      eof = true;
    } else {
      js_throw_error(env, ERR_reason_symbol_name(ERR_peek_last_error()), "Read failed");
      return NULL;
    }
  }

  int res = eof ? 0 : retry ? -1
                            : err;

  js_value_t *result;
  err = js_create_int64(env, res, &result);
  assert(err == 0);

  return result;
}

static js_value_t *
bare_tls_write(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 2);

  bare_tls_t *socket;
  err = js_get_arraybuffer_info(env, argv[0], (void **) &socket, NULL);
  assert(err == 0);

  char *buffer;
  size_t len;
  err = js_get_typedarray_info(env, argv[1], NULL, (void **) &buffer, &len, NULL, NULL);
  assert(err == 0);

  bool retry = false;

  err = SSL_write(socket->ssl, buffer, len);

  if (err <= 0) {
    err = SSL_get_error(socket->ssl, err);

    if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
      retry = true;
    } else {
      js_throw_error(env, ERR_reason_symbol_name(ERR_peek_last_error()), "Write failed");
      return NULL;
    }
  }

  int res = retry ? 0 : err;

  js_value_t *result;
  err = js_create_int64(env, res, &result);
  assert(err == 0);

  return result;
}

static js_value_t *
bare_tls_shutdown(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 1);

  bare_tls_t *socket;
  err = js_get_arraybuffer_info(env, argv[0], (void **) &socket, NULL);
  assert(err == 0);

  err = SSL_shutdown(socket->ssl);

  if (err < 0) {
    js_throw_error(env, ERR_reason_symbol_name(ERR_peek_last_error()), "Shutdown failed");
    return NULL;
  }

  js_value_t *result;
  err = js_get_boolean(env, err == 1, &result);
  assert(err == 0);

  return result;
}

static js_value_t *
bare_tls_exports(js_env_t *env, js_value_t *exports) {
  int err;

#define V(name, fn) \
  { \
    js_value_t *val; \
    err = js_create_function(env, name, -1, fn, NULL, &val); \
    assert(err == 0); \
    err = js_set_named_property(env, exports, name, val); \
    assert(err == 0); \
  }

  V("context", bare_tls_context);
  V("init", bare_tls_init);
  V("destroy", bare_tls_destroy);
  V("handshake", bare_tls_handshake);
  V("read", bare_tls_read);
  V("write", bare_tls_write);
  V("shutdown", bare_tls_shutdown);
#undef V

  return exports;
}

BARE_MODULE(bare_tls, bare_tls_exports)
