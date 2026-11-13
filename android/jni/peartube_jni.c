/*
 * JNI glue for libpeartube_native_ffi (peartube-native's C ABI). The Kotlin half
 * is com.peartube.shared.PearTubeNative; nothing here is PearTube-specific
 * beyond the class name, and ffi/README.md's JNI rules are the contract:
 * a global ref for the line consumer, a daemon attach on the output thread,
 * bytes copied during each call, and the global ref released after shutdown.
 *
 * One backend per process: a second pt_init replaces the first handle's
 * consumer ref, since the apps create one engine.
 */
#include <jni.h>
#include <stdlib.h>

#include "peartube_native.h"

static JavaVM *pt_vm;
static jmethodID pt_accept;
static jobject pt_consumer;
static void *pt_handle;

static void pt_deliver(void *user, const uint8_t *line, size_t len)
{
  JNIEnv *env = NULL;
  if (pt_vm == NULL) return;
  jint state = (*pt_vm)->GetEnv(pt_vm, (void **)&env, JNI_VERSION_1_6);
  if (state == JNI_EDETACHED) {
    if ((*pt_vm)->AttachCurrentThreadAsDaemon(pt_vm, (JNIEnv **)&env, NULL) != JNI_OK) return;
  } else if (state != JNI_OK) {
    return;
  }
  jbyteArray bytes = (*env)->NewByteArray(env, (jsize)len);
  if (bytes == NULL) {
    (*env)->ExceptionClear(env);
    return;
  }
  if (len > 0) (*env)->SetByteArrayRegion(env, bytes, 0, (jsize)len, (const jbyte *)line);
  (*env)->CallVoidMethod(env, (jobject)user, pt_accept, bytes);
  (*env)->DeleteLocalRef(env, bytes);
  if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
}

/* Copies a jbyteArray into freshly malloc'd memory; NULL for a null or empty array. */
static uint8_t *pt_copy(JNIEnv *env, jbyteArray array, size_t *len)
{
  *len = array == NULL ? 0 : (size_t)(*env)->GetArrayLength(env, array);
  if (*len == 0) return NULL;
  uint8_t *buffer = malloc(*len);
  if (buffer == NULL) return NULL;
  (*env)->GetByteArrayRegion(env, array, 0, (jsize)*len, (jbyte *)buffer);
  return buffer;
}

JNIEXPORT jint JNICALL
Java_com_peartube_shared_PearTubeNative_ptAbiVersion(JNIEnv *env, jobject self)
{
  (void)env;
  (void)self;
  return (jint)pt_abi_version();
}

JNIEXPORT jlong JNICALL
Java_com_peartube_shared_PearTubeNative_ptInit(JNIEnv *env, jobject self, jbyteArray config, jobject on)
{
  (void)self;
  if (on == NULL) return 0;
  if (pt_vm == NULL && (*env)->GetJavaVM(env, &pt_vm) != JNI_OK) return 0;
  if (pt_accept == NULL) {
    jclass consumer = (*env)->FindClass(env, "java/util/function/Consumer");
    if (consumer == NULL) return 0;
    pt_accept = (*env)->GetMethodID(env, consumer, "accept", "(Ljava/lang/Object;)V");
    (*env)->DeleteLocalRef(env, consumer);
    if (pt_accept == NULL) return 0;
  }
  size_t len = 0;
  uint8_t *bytes = pt_copy(env, config, &len);
  if (len > 0 && bytes == NULL) return 0;
  jobject ref = (*env)->NewGlobalRef(env, on);
  if (ref == NULL) {
    free(bytes);
    return 0;
  }
  void *handle = NULL;
  pt_status status = pt_init(bytes, len, pt_deliver, ref, &handle);
  free(bytes);
  if (status != PT_OK || handle == NULL) {
    (*env)->DeleteGlobalRef(env, ref);
    return 0;
  }
  jobject previous = pt_consumer;
  pt_consumer = ref;
  pt_handle = handle;
  if (previous != NULL) (*env)->DeleteGlobalRef(env, previous);
  return (jlong)(intptr_t)handle;
}

JNIEXPORT jint JNICALL
Java_com_peartube_shared_PearTubeNative_ptSendLine(JNIEnv *env, jobject self, jlong handle, jbyteArray line)
{
  (void)self;
  size_t len = 0;
  uint8_t *bytes = pt_copy(env, line, &len);
  if (len > 0 && bytes == NULL) return PT_ERR_NULL_ARG;
  pt_status status = pt_send_line((void *)(intptr_t)handle, bytes, len);
  free(bytes);
  return (jint)status;
}

JNIEXPORT void JNICALL
Java_com_peartube_shared_PearTubeNative_ptSuspend(JNIEnv *env, jobject self, jlong handle, jlong linger_ms)
{
  (void)env;
  (void)self;
  pt_suspend((void *)(intptr_t)handle, (uint64_t)linger_ms);
}

JNIEXPORT void JNICALL
Java_com_peartube_shared_PearTubeNative_ptResume(JNIEnv *env, jobject self, jlong handle)
{
  (void)env;
  (void)self;
  pt_resume((void *)(intptr_t)handle);
}

JNIEXPORT void JNICALL
Java_com_peartube_shared_PearTubeNative_ptShutdown(JNIEnv *env, jobject self, jlong handle)
{
  (void)self;
  void *raw = (void *)(intptr_t)handle;
  pt_shutdown(raw);
  if (pt_consumer != NULL && (pt_handle == NULL || pt_handle == raw)) {
    (*env)->DeleteGlobalRef(env, pt_consumer);
    pt_consumer = NULL;
    pt_handle = NULL;
  }
}
