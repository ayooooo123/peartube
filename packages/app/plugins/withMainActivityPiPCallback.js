const { withMainActivity } = require('@expo/config-plugins');

const REQUIRED_IMPORTS = [
  'import android.content.res.Configuration',
  'import to.holepunch.modules.mediasession.PipBridge',
];

const PIP_CALLBACK_METHODS = [
  'onUserLeaveHint',
  'onPictureInPictureModeChanged',
  'onConfigurationChanged',
  'onPictureInPictureUiStateChanged',
];

const PIP_CALLBACK_BLOCK = [
  '  override fun onUserLeaveHint() {',
  '      super.onUserLeaveHint()',
  '      PipBridge.onUserLeaveHint(this)',
  '  }',
  '',
  '  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {',
  '      super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)',
  '      PipBridge.notifyPipModeChanged(this, isInPictureInPictureMode, newConfig)',
  '  }',
  '',
  '  override fun onConfigurationChanged(newConfig: Configuration) {',
  '      super.onConfigurationChanged(newConfig)',
  '      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode) {',
  '          PipBridge.notifyPipBoundsChanged(this, newConfig)',
  '      }',
  '  }',
  '',
  '  override fun onPictureInPictureUiStateChanged(pipState: android.app.PictureInPictureUiState) {',
  '      super.onPictureInPictureUiStateChanged(pipState)',
  '      if (Build.VERSION.SDK_INT >= 35 && isInPictureInPictureMode) {',
  '          PipBridge.notifyPipUiStateChanged(this, pipState)',
  '      }',
  '  }',
].join('\n');

function ensureImport(contents, importLine) {
  if (contents.includes(importLine)) {
    return contents;
  }

  const importMatches = [...contents.matchAll(/^import .+$/gm)];
  if (importMatches.length > 0) {
    const lastImport = importMatches[importMatches.length - 1];
    const insertIndex = lastImport.index + lastImport[0].length;
    return `${contents.slice(0, insertIndex)}\n${importLine}${contents.slice(insertIndex)}`;
  }

  const packageMatch = contents.match(/^package .+$/m);
  if (packageMatch && typeof packageMatch.index === 'number') {
    const insertIndex = packageMatch.index + packageMatch[0].length;
    return `${contents.slice(0, insertIndex)}\n\n${importLine}${contents.slice(insertIndex)}`;
  }

  return `${importLine}\n${contents}`;
}

function stripOverrideMethod(contents, methodName) {
  let nextContents = contents;
  let methodIndex = nextContents.indexOf(`override fun ${methodName}(`);

  while (methodIndex !== -1) {
    const lineStart = nextContents.lastIndexOf('\n', methodIndex);
    const removeStart = lineStart === -1 ? 0 : lineStart + 1;
    const bodyStart = nextContents.indexOf('{', methodIndex);

    if (bodyStart === -1) {
      break;
    }

    let depth = 0;
    let cursor = bodyStart;

    while (cursor < nextContents.length) {
      const char = nextContents[cursor];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
      cursor += 1;
    }

    let removeEnd = cursor;
    while (removeEnd < nextContents.length && (nextContents[removeEnd] === '\n' || nextContents[removeEnd] === '\r')) {
      removeEnd += 1;
    }

    nextContents = `${nextContents.slice(0, removeStart)}${nextContents.slice(removeEnd)}`;
    methodIndex = nextContents.indexOf(`override fun ${methodName}(`);
  }

  return nextContents;
}

function applyCanonicalMainActivityPiPCallbacks(contents) {
  let nextContents = contents;

  for (const importLine of REQUIRED_IMPORTS) {
    nextContents = ensureImport(nextContents, importLine);
  }

  for (const methodName of PIP_CALLBACK_METHODS) {
    nextContents = stripOverrideMethod(nextContents, methodName);
  }

  const lastBraceIndex = nextContents.lastIndexOf('}');
  if (lastBraceIndex === -1) {
    return nextContents;
  }

  const prefix = nextContents.slice(0, lastBraceIndex).replace(/\s*$/, '\n');
  return `${prefix}\n${PIP_CALLBACK_BLOCK}\n}\n`;
}

function withMainActivityPiPCallback(config) {
  return withMainActivity(config, (config) => {
    config.modResults.contents = applyCanonicalMainActivityPiPCallbacks(config.modResults.contents);
    return config;
  });
}

module.exports = withMainActivityPiPCallback;
module.exports._applyCanonicalMainActivityPiPCallbacks = applyCanonicalMainActivityPiPCallbacks;
