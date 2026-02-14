#if __has_include(<React/RCTViewManager.h>)
#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(MpvPlayerViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(source, NSDictionary)
RCT_EXPORT_VIEW_PROPERTY(paused, BOOL)
RCT_EXPORT_VIEW_PROPERTY(rate, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(volume, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(muted, BOOL)
RCT_EXPORT_VIEW_PROPERTY(seek, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(resizeMode, NSString)

RCT_EXPORT_VIEW_PROPERTY(onLoad, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onProgress, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPlaying, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPaused, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onBuffering, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onEnded, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onError, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onVideoStateChange, RCTDirectEventBlock)

RCT_EXTERN_METHOD(play:(nonnull NSNumber *)node)
RCT_EXTERN_METHOD(pause:(nonnull NSNumber *)node)
RCT_EXTERN_METHOD(stop:(nonnull NSNumber *)node)
RCT_EXTERN_METHOD(seekToSeconds:(nonnull NSNumber *)node seconds:(nonnull NSNumber *)seconds)

@end
#endif
