/**
 * Audio Transcoder - Converts incompatible audio codecs to AAC
 *
 * Uses ffmpeg.wasm to transcode MKV files with AC3/DTS audio
 * to browser-compatible AAC audio while preserving video.
 */

import { Platform } from 'react-native';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let ffmpeg: FFmpeg | null = null;
let ffmpegLoading = false;
let ffmpegLoaded = false;
const AUDIO_TRANSCODE_ENABLED = Platform.OS === 'web';

/**
 * Load FFmpeg WASM (lazy-loaded on first use)
 */
async function loadFFmpeg(onProgress?: (progress: number) => void): Promise<FFmpeg> {
  if (ffmpegLoaded && ffmpeg) {
    return ffmpeg;
  }

  if (ffmpegLoading) {
    // Wait for existing load to complete
    while (ffmpegLoading) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (ffmpeg) return ffmpeg;
  }

  ffmpegLoading = true;

  try {
    ffmpeg = new FFmpeg();

    ffmpeg.on('progress', ({ progress }) => {
      onProgress?.(Math.round(progress * 100));
    });

    // Load ffmpeg core from CDN
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpegLoaded = true;
    console.log('[AudioTranscoder] FFmpeg loaded successfully');
    return ffmpeg;
  } catch (err) {
    console.error('[AudioTranscoder] Failed to load FFmpeg:', err);
    ffmpegLoading = false;
    throw err;
  } finally {
    ffmpegLoading = false;
  }
}

/**
 * Check if a file needs audio transcoding based on extension
 */
export function needsAudioTranscode(filename: string): boolean {
  if (!AUDIO_TRANSCODE_ENABLED) return false;
  const ext = filename.split('.').pop()?.toLowerCase();
  // MKV files may contain AC3/DTS audio that browsers can't play
  return ext === 'mkv';
}

/**
 * Probe a video file to check if it has incompatible audio
 * Returns true if audio needs transcoding
 */
export async function probeAudioCodec(file: File | ArrayBuffer): Promise<{
  needsTranscode: boolean;
  audioCodec?: string;
  videoCodec?: string;
}> {
  if (!AUDIO_TRANSCODE_ENABLED) {
    return {
      needsTranscode: false,
      audioCodec: 'unknown',
      videoCodec: 'unknown'
    };
  }
  // For now, assume all MKV files need transcoding since we can't easily probe
  // In the future, we could use ffprobe via ffmpeg.wasm
  const filename = file instanceof File ? file.name : 'video.mkv';
  return {
    needsTranscode: needsAudioTranscode(filename),
    audioCodec: 'unknown',
    videoCodec: 'unknown'
  };
}

export interface TranscodeOptions {
  onProgress?: (progress: number) => void;
  onStatus?: (status: string) => void;
}

export interface TranscodeResult {
  data: Uint8Array;
  filename: string;
  size: number;
  transcoded: boolean;
}

/**
 * Transcode video audio to AAC while preserving video stream
 * Input: MKV with AC3/DTS audio
 * Output: MKV with AAC audio (browser compatible)
 */
export async function transcodeAudio(
  file: File | ArrayBuffer,
  filename: string,
  options: TranscodeOptions = {}
): Promise<TranscodeResult> {
  const { onProgress, onStatus } = options;

  if (!AUDIO_TRANSCODE_ENABLED) {
    const data = file instanceof File
      ? new Uint8Array(await file.arrayBuffer())
      : new Uint8Array(file);
    return {
      data,
      filename,
      size: data.length,
      transcoded: false
    };
  }

  // Check if transcoding is needed
  if (!needsAudioTranscode(filename)) {
    console.log('[AudioTranscoder] No transcoding needed for:', filename);
    const data = file instanceof File
      ? new Uint8Array(await file.arrayBuffer())
      : new Uint8Array(file);
    return {
      data,
      filename,
      size: data.length,
      transcoded: false
    };
  }

  onStatus?.('Loading transcoder...');
  const ff = await loadFFmpeg(onProgress);

  onStatus?.('Preparing file...');
  const inputFilename = 'input.mkv';
  const outputFilename = 'output.mkv';

  // Write input file to FFmpeg virtual filesystem
  const fileData = file instanceof File
    ? await fetchFile(file)
    : new Uint8Array(file);
  await ff.writeFile(inputFilename, fileData);

  onStatus?.('Transcoding audio to AAC...');

  // Transcode: copy video stream, convert audio to AAC
  // -c:v copy = copy video without re-encoding
  // -c:a aac = convert audio to AAC
  // -b:a 192k = 192kbps audio bitrate (good quality)
  await ff.exec([
    '-i', inputFilename,
    '-c:v', 'copy',      // Copy video stream (no re-encode)
    '-c:a', 'aac',       // Convert audio to AAC
    '-b:a', '192k',      // Audio bitrate
    '-y',                // Overwrite output
    outputFilename
  ]);

  onStatus?.('Reading output...');
  const outputData = await ff.readFile(outputFilename);

  // Clean up
  await ff.deleteFile(inputFilename);
  await ff.deleteFile(outputFilename);

  const result = outputData as Uint8Array;
  console.log('[AudioTranscoder] Transcoding complete:', {
    inputSize: fileData.length,
    outputSize: result.length
  });

  return {
    data: result,
    filename,
    size: result.length,
    transcoded: true
  };
}

/**
 * Check if FFmpeg is loaded
 */
export function isFFmpegLoaded(): boolean {
  return ffmpegLoaded;
}

/**
 * Preload FFmpeg (call early to speed up first transcode)
 */
export async function preloadFFmpeg(): Promise<void> {
  if (!AUDIO_TRANSCODE_ENABLED) return;
  try {
    await loadFFmpeg();
  } catch (err) {
    console.warn('[AudioTranscoder] Preload failed:', err);
  }
}
