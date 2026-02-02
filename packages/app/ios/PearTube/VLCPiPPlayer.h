#import <UIKit/UIKit.h>
#import <AVKit/AVKit.h>
#import <MobileVLCKit/MobileVLCKit.h>
#import <React/RCTComponent.h>

NS_ASSUME_NONNULL_BEGIN

API_AVAILABLE(ios(15.0))
@interface VLCPiPPlayer : UIView <AVPictureInPictureSampleBufferPlaybackDelegate, AVPictureInPictureControllerDelegate>

@property (nonatomic, strong, readonly) VLCMediaPlayer *mediaPlayer;
@property (nonatomic, strong, readonly, nullable) AVPictureInPictureController *pipController;
@property (nonatomic, assign, readonly) BOOL isPiPSupported;
@property (nonatomic, assign, readonly) BOOL isPiPActive;

@property (nonatomic, copy, nullable) RCTDirectEventBlock onPiPStateChange;
@property (nonatomic, copy, nullable) RCTDirectEventBlock onPlaybackStateChange;
@property (nonatomic, copy, nullable) RCTDirectEventBlock onError;
@property (nonatomic, copy, nullable) RCTDirectEventBlock onProgress;
@property (nonatomic, copy, nullable) RCTDirectEventBlock onLoad;
@property (nonatomic, copy, nullable) RCTDirectEventBlock onEnd;

- (void)setMediaURL:(NSURL *)url;
- (void)play;
- (void)pause;
- (void)stop;
- (void)seek:(float)position;

- (BOOL)startPiP;
- (void)stopPiP;

@end

NS_ASSUME_NONNULL_END
