const { withMainActivity } = require('@expo/config-plugins');

const IMPORT_BLOCK = `import android.content.res.Configuration
import to.holepunch.modules.mediasession.PipBridge`;

const PIP_CALLBACK_BLOCK = `
  override fun onUserLeaveHint() {
      super.onUserLeaveHint()
      PipBridge.onUserLeaveHint(this)
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
      super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
      PipBridge.notifyPipModeChanged(this, isInPictureInPictureMode, newConfig)
  }`;

function withMainActivityPiPCallback(config) {
  return withMainActivity(config, (config) => {
    let contents = config.modResults.contents;

    if (!contents.includes('import to.holepunch.modules.mediasession.PipBridge')) {
      const importMatch = contents.match(/import expo\.modules\.ReactActivityDelegateWrapper\n/);
      if (importMatch) {
        contents = contents.replace(
          'import expo.modules.ReactActivityDelegateWrapper',
          `import expo.modules.ReactActivityDelegateWrapper\n${IMPORT_BLOCK}`
        );
      }
    }

    if (!contents.includes('onPictureInPictureModeChanged')) {
      const lastBraceIndex = contents.lastIndexOf('}');
      if (lastBraceIndex !== -1) {
        contents = contents.slice(0, lastBraceIndex) + PIP_CALLBACK_BLOCK + '\n' + contents.slice(lastBraceIndex);
      }
    }

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withMainActivityPiPCallback;
