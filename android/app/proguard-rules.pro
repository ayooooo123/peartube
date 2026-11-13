# bare-kit-kotlin's JNI bridge looks up Native, BareKitException$Failed and the
# Worklet.onExit()/Ipc.onPoll() callbacks by name.
-keep class to.holepunch.bare.kit.** { *; }

# libpeartube.so binds its functions to these names.
-keepclasseswithmembernames class com.peartube.app.player.NativePlayer {
    native <methods>;
}

# libpeartube_jni.so binds its functions to these names.
-keepclasseswithmembernames class com.peartube.shared.PearTubeNative {
    native <methods>;
}
