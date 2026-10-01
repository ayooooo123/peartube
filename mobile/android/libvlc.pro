# libVLC's native code calls back into these classes by name.
-keep class org.videolan.libvlc.** { *; }

# Rust calls these through JNI.
-keep class dev.dioxus.main.MainActivity {
  public void play(java.lang.String);
  public void closePlayer();
}
