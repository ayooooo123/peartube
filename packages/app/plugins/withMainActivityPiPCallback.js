const { withMainActivity } = require('@expo/config-plugins');

const IMPORT_BLOCK = `import android.content.res.Configuration
import to.holepunch.modules.mediasession.PipBridge`;

const PIP_CALLBACK_BLOCK = `
  /**
   * Called when user presses home button. VLC Android's approach:
   * Enter PiP with correct aspect ratio already set.
   */
  override fun onUserLeaveHint() {
      super.onUserLeaveHint()
      android.util.Log.d("MainActivity", "onUserLeaveHint")
      PipBridge.onUserLeaveHint(this)
  }

  /**
   * Called when PiP mode changes. Just notify JS layer with new config for accurate dimensions.
   */
  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
      super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
      PipBridge.notifyPipModeChanged(this, isInPictureInPictureMode, newConfig)
  }

  /**
   * Called when configuration changes (including PiP window resize).
   * Re-notify PipBridge when resizing while in PiP mode.
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
      super.onConfigurationChanged(newConfig)
      if (isInPictureInPictureMode) {
          android.util.Log.d("MainActivity", "onConfigurationChanged while in PiP")
          PipBridge.notifyPipModeChanged(this, true, newConfig)
      }
  }`;

function withMainActivityPiPCallback(config) {
  return withMainActivity(config, (config) => {
    let contents = config.modResults.contents;

    // Add imports after the last existing import
    if (!contents.includes('import to.holepunch.modules.mediasession.PipBridge')) {
      const importMatch = contents.match(/import expo\.modules\.ReactActivityDelegateWrapper\n/);
      if (importMatch) {
        contents = contents.replace(
          'import expo.modules.ReactActivityDelegateWrapper',
          `import expo.modules.ReactActivityDelegateWrapper\n${IMPORT_BLOCK}`
        );
      }
    }

    // Add PiP callback methods before the final closing brace
    if (!contents.includes('onPictureInPictureModeChanged')) {
      // Find the last closing brace of the class
      const lastBraceIndex = contents.lastIndexOf('}');
      if (lastBraceIndex !== -1) {
        contents = contents.slice(0, lastBraceIndex) + PIP_CALLBACK_BLOCK + '\n}\n';
      }
    }

    config.modResults.contents = contents;
    console.log('[withMainActivityPiPCallback] Added PiP callback to MainActivity');
    return config;
  });
}

module.exports = withMainActivityPiPCallback;
