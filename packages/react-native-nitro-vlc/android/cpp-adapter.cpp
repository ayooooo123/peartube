#include <jni.h>
#include "NitroVLCOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::nitrovlc::initialize(vm);
}
