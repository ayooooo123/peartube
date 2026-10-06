# Rust calls these through JNI (mobile/src/android_player.rs), and registers
# the natives on them by name, so R8 must keep them.
-keep class dev.dioxus.main.MainActivity {
  public void openPlayer();
  public void setPlayerFrame(float, float, float, float);
  public void closePlayer();
  public void back();
  native <methods>;
}
