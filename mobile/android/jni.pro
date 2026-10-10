# Rust calls these through JNI (android_player.rs and soundfont/android.rs),
# and registers the natives by name, so R8 must keep them.
-keep class dev.dioxus.main.MainActivity {
  public void openPlayer();
  public void setPlayerFrame(float, float, float, float);
  public void closePlayer();
  public void back();
  public void pickSoundFont(long, java.lang.String, long);
  public void cancelSoundFont(long);
  native <methods>;
}
