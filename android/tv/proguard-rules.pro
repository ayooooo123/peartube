-keep class to.holepunch.bare.kit.** { *; }
-keepclasseswithmembernames class com.peartube.shared.PearTubeNative {
    native <methods>;
}
-keepclasseswithmembernames class com.peartube.app.player.NativePlayer {
    native <methods>;
}
# R8's write-only field elimination strips unread lock fields on Application, causing GC finalize()
# to release WifiLock & MulticastLock (proven via 1-variable A/B: 846dec88 vs 55b9b4a0).
-keepclassmembers class com.peartube.receiver.ReceiverApp {
    private android.net.wifi.WifiManager$MulticastLock *;
    private android.net.wifi.WifiManager$WifiLock *;
    private android.os.PowerManager$WakeLock *;
}
