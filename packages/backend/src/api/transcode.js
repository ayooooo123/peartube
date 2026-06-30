// Transcoder (VideoToolbox) settings API group, extracted from api.js.
import { getVideoToolboxDecodeSettings, setVideoToolboxDecodeEnabled, setVideoToolboxHwMapEnabled } from '../transcode/videotoolbox-settings.mjs'

export function createTranscodeApi({ ctx }) {
  return {
    /**
     * Get transcoder settings for troubleshooting
     * @returns {Promise<{ settings: { videoToolboxDecodeEnabled: boolean, videoToolboxDecodeLocked: boolean, videoToolboxDecodeDefault: boolean, videoToolboxDecodeSource: string, videoToolboxHwMapEnabled: boolean, videoToolboxHwMapLocked: boolean, videoToolboxHwMapDefault: boolean, videoToolboxHwMapSource: string } }>}
     */
    async getTranscodeSettings() {
      return { settings: getVideoToolboxDecodeSettings() };
    },

    /**
     * Update transcoder settings for troubleshooting
     * @param {Object} req
     * @param {boolean} [req.videoToolboxDecodeEnabled]
     * @param {boolean} [req.videoToolboxHwMapEnabled]
     * @returns {Promise<{ success: boolean, error?: string, settings: object }>}
     */
    async setTranscodeSettings(req) {
      const decodeEnabled = req?.videoToolboxDecodeEnabled;
      const hwMapEnabled = req?.videoToolboxHwMapEnabled;
      const hasDecode = typeof decodeEnabled === 'boolean';
      const hasHwMap = typeof hwMapEnabled === 'boolean';
      if (!hasDecode && !hasHwMap) {
        return { success: false, error: 'Invalid request', settings: getVideoToolboxDecodeSettings() };
      }

      let settings = getVideoToolboxDecodeSettings();
      if (hasDecode) settings = setVideoToolboxDecodeEnabled(decodeEnabled, 'ui');
      if (hasHwMap) settings = setVideoToolboxHwMapEnabled(hwMapEnabled, 'ui');

      if (hasDecode && settings.videoToolboxDecodeLocked) {
        return { success: false, error: 'Locked by PEARTUBE_ENABLE_VT_DECODE', settings };
      }
      if (hasHwMap && settings.videoToolboxHwMapLocked) {
        return { success: false, error: 'Locked by PEARTUBE_ENABLE_VT_HWMAP', settings };
      }

      try {
        await ctx.metaDb.put('transcode-settings', {
          videoToolboxDecodeEnabled: settings.videoToolboxDecodeEnabled,
          videoToolboxHwMapEnabled: settings.videoToolboxHwMapEnabled
        });
      } catch (err) {
        console.log('[API] Failed to persist transcode settings:', err?.message);
      }

      return { success: true, settings };
    },
  }
}
