/**
 * Platform Abstraction Layer - TypeScript Declarations
 */

export type PlatformType = 'ios' | 'android' | 'pear-macos' | 'pear-windows' | 'pear-linux' | 'web' | 'bare';
export type PlatformCategory = 'mobile' | 'desktop' | 'web';

// Video stats from P2P download
export interface VideoStats {
  status: 'connecting' | 'resolving' | 'downloading' | 'complete' | 'error' | 'unknown';
  progress: number;
  totalBlocks: number;
  downloadedBlocks: number;
  totalBytes: number;
  downloadedBytes: number;
  peerCount: number;
  speedMBps: string;
  uploadSpeedMBps?: string;
  elapsed: number;
  isComplete: boolean;
}

export interface LayoutInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlatformCapabilities {
  hasFilePicker: boolean;
  hasCamera: boolean;
  hasNotifications: boolean;
  hasBackgroundTasks: boolean;
  hasP2P: boolean;
  hasNativeUI: boolean;
}

export interface PlatformInfo {
  type: PlatformType;
  category: PlatformCategory;
  insets: LayoutInsets;
  capabilities: PlatformCapabilities;
  storagePath: string;
}

export interface FilePickerResult {
  cancelled: boolean;
  filePath?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  uri?: string;
}

export interface FilePickerOptions {
  allowedTypes?: string[];
  multiple?: boolean;
}

// Platform detection
export function isBare(): boolean;
export function isPear(): boolean;
export function isReactNative(): boolean;
export function isWeb(): boolean;
export function isDesktop(platform?: PlatformType): boolean;
export function isMobile(platform?: PlatformType): boolean;
export function detectPlatform(): PlatformType;
export function getPlatformCategory(platform: PlatformType): PlatformCategory;
export function getLayoutInsets(platform: PlatformType): LayoutInsets;
export function getPlatformCapabilities(platform: PlatformType): PlatformCapabilities;
export function getPlatformInfo(): PlatformInfo;

export const currentPlatform: PlatformType;
export const currentCategory: PlatformCategory;
export const currentCapabilities: PlatformCapabilities;

// Storage utilities
export function getStoragePath(options?: { appName?: string; providedPath?: string }): string;
export function getDataPath(basePath: string): string;
export function getCachePath(basePath: string): string;
export function getLogsPath(basePath: string): string;
export function getTempPath(basePath: string): string;
export function getStoragePaths(basePath: string): {
  base: string;
  data: string;
  cache: string;
  logs: string;
  temp: string;
};
