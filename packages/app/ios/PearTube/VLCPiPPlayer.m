#import "VLCPiPPlayer.h"
#import <CoreMedia/CoreMedia.h>
#import <VideoToolbox/VideoToolbox.h>
#import <MobileVLCKit/MobileVLCKit.h>
#import <AVFoundation/AVFoundation.h>
#import <stdatomic.h>

#pragma mark - libvlc Forward Declarations

typedef struct libvlc_media_player_t libvlc_media_player_t;
typedef void *(*libvlc_video_lock_cb)(void *opaque, void **planes);
typedef void (*libvlc_video_unlock_cb)(void *opaque, void *picture, void *const *planes);
typedef void (*libvlc_video_display_cb)(void *opaque, void *picture);
typedef unsigned (*libvlc_video_format_cb)(void **opaque, char *chroma, unsigned *width, unsigned *height, unsigned *pitches, unsigned *lines);
typedef void (*libvlc_video_cleanup_cb)(void *opaque);

extern void libvlc_video_set_callbacks(libvlc_media_player_t *mp, libvlc_video_lock_cb lock, libvlc_video_unlock_cb unlock, libvlc_video_display_cb display, void *opaque);
extern void libvlc_video_set_format_callbacks(libvlc_media_player_t *mp, libvlc_video_format_cb setup, libvlc_video_cleanup_cb cleanup);

@interface VLCMediaPlayer (LibVLCBridging)
@property (readonly) void *libVLCMediaPlayer;
@end

static const NSInteger kPixelBufferPoolSize = 3;

#pragma mark - Frame Context

typedef struct {
    void *owner;
    CVPixelBufferRef pixelBuffer;
    CMTime presentationTime;
} VLCFrameContext;

#pragma mark - VLCPiPPlayer Private Interface

API_AVAILABLE(ios(15.0))
@interface VLCPiPPlayer () <VLCMediaPlayerDelegate> {
    // Atomic frame counter for thread-safe access from vmem callbacks
    _Atomic uint64_t _atomicFrameCount;
    // Flag to prevent callbacks firing after dealloc starts
    _Atomic BOOL _isBeingDeallocated;
}

// VLC media player
@property (nonatomic, strong, readwrite) VLCMediaPlayer *mediaPlayer;

// AVSampleBuffer layer for PiP
@property (nonatomic, strong) AVSampleBufferDisplayLayer *sampleBufferLayer;

// PiP controller
@property (nonatomic, strong, readwrite, nullable) AVPictureInPictureController *pipController;

// CVPixelBuffer pool
@property (nonatomic, assign) CVPixelBufferPoolRef pixelBufferPool;
@property (nonatomic, strong) NSMutableArray<NSValue *> *availablePixelBuffers;
@property (nonatomic, strong) dispatch_queue_t bufferQueue;

// Video format info
@property (nonatomic, assign) unsigned videoWidth;
@property (nonatomic, assign) unsigned videoHeight;
@property (nonatomic, assign) unsigned videoPitch;
@property (nonatomic, assign) BOOL formatConfigured;

// Timing
@property (nonatomic, assign) CMTime baseTime;

// State
@property (nonatomic, assign, readwrite) BOOL isPiPActive;
@property (nonatomic, assign) BOOL isPlaying;

// Playback source
@property (nonatomic, strong) AVSampleBufferRenderSynchronizer *renderSynchronizer;

- (void)createPixelBufferPoolWithWidth:(unsigned)width height:(unsigned)height;
- (void)destroyPixelBufferPool;

@end

#pragma mark - libvlc vmem Callbacks

// Forward declarations
static void *vlc_lock_cb(void *opaque, void **planes);
static void vlc_unlock_cb(void *opaque, void *picture, void *const *planes);
static void vlc_display_cb(void *opaque, void *picture);
static unsigned vlc_format_cb(void **opaque, char *chroma, unsigned *width, unsigned *height, unsigned *pitches, unsigned *lines);
static void vlc_cleanup_cb(void *opaque);

// Lock callback - provide buffer for VLC to decode into
// IMPORTANT: This is called from VLC's decoder thread, NOT the main thread
static void *vlc_lock_cb(void *opaque, void **planes) {
    VLCPiPPlayer *player = (__bridge VLCPiPPlayer *)opaque;

    // Early exit if player is being deallocated
    if (atomic_load(&player->_isBeingDeallocated)) {
        return NULL;
    }

    __block CVPixelBufferRef pixelBuffer = NULL;

    // Use dispatch_sync safely - bufferQueue is a serial queue that we control
    // and VLC decoder thread is separate from our buffer queue
    dispatch_sync(player.bufferQueue, ^{
        if (player.availablePixelBuffers.count > 0) {
            pixelBuffer = (CVPixelBufferRef)[player.availablePixelBuffers.lastObject pointerValue];
            [player.availablePixelBuffers removeLastObject];
        }
    });

    if (!pixelBuffer && player.pixelBufferPool) {
        CVReturn result = CVPixelBufferPoolCreatePixelBuffer(NULL, player.pixelBufferPool, &pixelBuffer);
        if (result != kCVReturnSuccess) {
            NSLog(@"VLCPiPPlayer: Failed to create pixel buffer: %d", result);
            return NULL;
        }
    }

    if (!pixelBuffer) {
        return NULL;
    }

    CVPixelBufferLockBaseAddress(pixelBuffer, 0);
    planes[0] = CVPixelBufferGetBaseAddress(pixelBuffer);

    VLCFrameContext *ctx = malloc(sizeof(VLCFrameContext));
    if (!ctx) {
        // Memory allocation failed - must unlock and release the buffer
        CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
        CVPixelBufferRelease(pixelBuffer);
        NSLog(@"VLCPiPPlayer: Failed to allocate frame context");
        return NULL;
    }

    ctx->owner = (__bridge void *)player;
    ctx->pixelBuffer = pixelBuffer;
    // Use atomic load for thread-safe access to frame count
    uint64_t currentFrame = atomic_load(&player->_atomicFrameCount);
    ctx->presentationTime = CMTimeMake(currentFrame * 1001, 30000); // Assume 29.97 fps

    return ctx;
}

// Unlock callback - frame decode complete
static void vlc_unlock_cb(void *opaque, void *picture, void *const *planes) {
    if (!picture) return;
    
    VLCFrameContext *ctx = (VLCFrameContext *)picture;
    CVPixelBufferRef pixelBuffer = ctx->pixelBuffer;
    
    if (pixelBuffer) {
        CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
    }
}

// Display callback - enqueue frame to sample buffer layer
static void vlc_display_cb(void *opaque, void *picture) {
    if (!picture) return;

    VLCFrameContext *ctx = (VLCFrameContext *)picture;
    VLCPiPPlayer *player = (__bridge VLCPiPPlayer *)ctx->owner;

    // Early exit if player is being deallocated
    if (atomic_load(&player->_isBeingDeallocated)) {
        CVPixelBufferRelease(ctx->pixelBuffer);
        free(ctx);
        return;
    }
    CVPixelBufferRef pixelBuffer = ctx->pixelBuffer;
    
    if (pixelBuffer && player.sampleBufferLayer) {
        // Create format description
        CMVideoFormatDescriptionRef formatDesc = NULL;
        OSStatus status = CMVideoFormatDescriptionCreateForImageBuffer(NULL, pixelBuffer, &formatDesc);
        
        if (status == noErr && formatDesc) {
            // Create timing info
            CMSampleTimingInfo timingInfo = {
                .duration = CMTimeMake(1001, 30000),
                .presentationTimeStamp = ctx->presentationTime,
                .decodeTimeStamp = kCMTimeInvalid
            };
            
            // Create sample buffer
            CMSampleBufferRef sampleBuffer = NULL;
            status = CMSampleBufferCreateReadyWithImageBuffer(
                NULL,
                pixelBuffer,
                formatDesc,
                &timingInfo,
                &sampleBuffer
            );
            
            if (status == noErr && sampleBuffer) {
                // Attach for display immediately
                CFArrayRef attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, YES);
                if (attachmentsArray && CFArrayGetCount(attachmentsArray) > 0) {
                    CFMutableDictionaryRef attachments = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachmentsArray, 0);
                    CFDictionarySetValue(attachments, kCMSampleAttachmentKey_DisplayImmediately, kCFBooleanTrue);
                }
                
                // Enqueue to sample buffer layer
                if (player.sampleBufferLayer.isReadyForMoreMediaData) {
                    [player.sampleBufferLayer enqueueSampleBuffer:sampleBuffer];
                }
                
                CFRelease(sampleBuffer);
            }
            
            CFRelease(formatDesc);
        }
        
        // Return buffer to pool
        dispatch_async(player.bufferQueue, ^{
            if (player.availablePixelBuffers.count < kPixelBufferPoolSize) {
                [player.availablePixelBuffers addObject:[NSValue valueWithPointer:pixelBuffer]];
            } else {
                CVPixelBufferRelease(pixelBuffer);
            }
        });
    }
    
    // Atomically increment frame counter for thread safety
    atomic_fetch_add(&player->_atomicFrameCount, 1);
    free(ctx);
}

// Format callback - configure video format
static unsigned vlc_format_cb(void **opaque, char *chroma, unsigned *width, unsigned *height, unsigned *pitches, unsigned *lines) {
    VLCPiPPlayer *player = (__bridge VLCPiPPlayer *)(*opaque);
    
    // Request BGRA format for iOS compatibility
    memcpy(chroma, "BGRA", 4);
    
    // Store dimensions
    player.videoWidth = *width;
    player.videoHeight = *height;
    player.videoPitch = *width * 4; // 4 bytes per pixel for BGRA
    
    // Set output format
    pitches[0] = player.videoPitch;
    lines[0] = *height;
    
    // Create pixel buffer pool
    [player createPixelBufferPoolWithWidth:*width height:*height];
    
    player.formatConfigured = YES;
    
    NSLog(@"VLCPiPPlayer: Format configured - %ux%u BGRA", *width, *height);
    
    return 1; // 1 buffer
}

// Cleanup callback
static void vlc_cleanup_cb(void *opaque) {
    VLCPiPPlayer *player = (__bridge VLCPiPPlayer *)opaque;
    [player destroyPixelBufferPool];
    player.formatConfigured = NO;
    NSLog(@"VLCPiPPlayer: Format cleanup");
}

#pragma mark - VLCPiPPlayer Implementation

@implementation VLCPiPPlayer

#pragma mark - Initialization

- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (self) {
        [self commonInit];
    }
    return self;
}

- (instancetype)initWithCoder:(NSCoder *)coder {
    self = [super initWithCoder:coder];
    if (self) {
        [self commonInit];
    }
    return self;
}

- (void)commonInit {
    self.backgroundColor = [UIColor blackColor];

    // Initialize atomic variables
    atomic_store(&_atomicFrameCount, 0);
    atomic_store(&_isBeingDeallocated, NO);

    // Configure audio session for playback
    NSError *audioError = nil;
    AVAudioSession *audioSession = [AVAudioSession sharedInstance];
    [audioSession setCategory:AVAudioSessionCategoryPlayback
                         mode:AVAudioSessionModeMoviePlayback
                      options:AVAudioSessionCategoryOptionAllowAirPlay
                        error:&audioError];
    if (audioError) {
        NSLog(@"VLCPiPPlayer: Audio session error: %@", audioError);
    }
    [audioSession setActive:YES error:nil];

    // Create buffer queue
    self.bufferQueue = dispatch_queue_create("com.peartube.vlcpip.bufferqueue", DISPATCH_QUEUE_SERIAL);
    self.availablePixelBuffers = [NSMutableArray array];

    // Create sample buffer display layer
    self.sampleBufferLayer = [[AVSampleBufferDisplayLayer alloc] init];
    self.sampleBufferLayer.videoGravity = AVLayerVideoGravityResizeAspect;
    self.sampleBufferLayer.backgroundColor = [UIColor blackColor].CGColor;
    [self.layer addSublayer:self.sampleBufferLayer];

    // Create VLC media player with vmem callbacks
    self.mediaPlayer = [[VLCMediaPlayer alloc] init];
    self.mediaPlayer.delegate = self;

    // Set up vmem callbacks
    [self setupVmemCallbacks];

    // Set up render synchronizer for PiP
    self.renderSynchronizer = [[AVSampleBufferRenderSynchronizer alloc] init];
    [self.renderSynchronizer addRenderer:self.sampleBufferLayer];

    // Set up PiP controller
    [self setupPiPController];

    self.baseTime = kCMTimeZero;
}

- (void)layoutSubviews {
    [super layoutSubviews];
    self.sampleBufferLayer.frame = self.bounds;
}

- (void)dealloc {
    // Signal to callbacks that we're being deallocated - prevent new frames
    atomic_store(&_isBeingDeallocated, YES);

    // Stop playback first
    [self stop];

    // Clear vmem callbacks BEFORE releasing media player to prevent use-after-free
    // The callbacks reference 'self' as opaque data, so we must clear them first
    void *libvlcPlayer = [_mediaPlayer libVLCMediaPlayer];
    if (libvlcPlayer) {
        libvlc_media_player_t *mp = (libvlc_media_player_t *)libvlcPlayer;
        // Set NULL callbacks to prevent any further callback invocations
        libvlc_video_set_callbacks(mp, NULL, NULL, NULL, NULL);
        libvlc_video_set_format_callbacks(mp, NULL, NULL);
    }

    [self destroyPixelBufferPool];

    if (_pipController) {
        _pipController.delegate = nil;
        _pipController = nil;
    }

    if (_renderSynchronizer) {
        [_renderSynchronizer removeRenderer:_sampleBufferLayer atTime:kCMTimeZero completionHandler:nil];
        _renderSynchronizer = nil;
    }
}

#pragma mark - vmem Setup

- (void)setupVmemCallbacks {
    // Get libvlc media player pointer
    void *libvlcPlayer = [self.mediaPlayer libVLCMediaPlayer];
    
    if (!libvlcPlayer) {
        NSLog(@"VLCPiPPlayer: Failed to get libvlc media player");
        return;
    }
    
    libvlc_media_player_t *mp = (libvlc_media_player_t *)libvlcPlayer;
    
    // Set format callbacks (with setup and cleanup)
    libvlc_video_set_format_callbacks(mp, vlc_format_cb, vlc_cleanup_cb);
    
    // Set video callbacks
    libvlc_video_set_callbacks(mp, vlc_lock_cb, vlc_unlock_cb, vlc_display_cb, (__bridge void *)self);
    
    NSLog(@"VLCPiPPlayer: vmem callbacks configured");
}

#pragma mark - Pixel Buffer Pool

- (void)createPixelBufferPoolWithWidth:(unsigned)width height:(unsigned)height {
    [self destroyPixelBufferPool];
    
    NSDictionary *pixelBufferAttributes = @{
        (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (id)kCVPixelBufferWidthKey: @(width),
        (id)kCVPixelBufferHeightKey: @(height),
        (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
        (id)kCVPixelBufferCGImageCompatibilityKey: @YES,
        (id)kCVPixelBufferCGBitmapContextCompatibilityKey: @YES
    };
    
    NSDictionary *poolAttributes = @{
        (id)kCVPixelBufferPoolMinimumBufferCountKey: @(kPixelBufferPoolSize)
    };
    
    CVReturn result = CVPixelBufferPoolCreate(
        NULL,
        (__bridge CFDictionaryRef)poolAttributes,
        (__bridge CFDictionaryRef)pixelBufferAttributes,
        &_pixelBufferPool
    );
    
    if (result != kCVReturnSuccess) {
        NSLog(@"VLCPiPPlayer: Failed to create pixel buffer pool: %d", result);
    } else {
        NSLog(@"VLCPiPPlayer: Created pixel buffer pool %ux%u", width, height);
    }
}

- (void)destroyPixelBufferPool {
    dispatch_sync(self.bufferQueue, ^{
        // Release all available buffers
        for (NSValue *value in self.availablePixelBuffers) {
            CVPixelBufferRef buffer = (CVPixelBufferRef)[value pointerValue];
            CVPixelBufferRelease(buffer);
        }
        [self.availablePixelBuffers removeAllObjects];
    });
    
    if (_pixelBufferPool) {
        CVPixelBufferPoolRelease(_pixelBufferPool);
        _pixelBufferPool = NULL;
    }
}

#pragma mark - PiP Setup

- (void)setupPiPController {
    if (![AVPictureInPictureController isPictureInPictureSupported]) {
        NSLog(@"VLCPiPPlayer: PiP not supported on this device");
        return;
    }
    
    // Create content source from sample buffer layer
    AVPictureInPictureControllerContentSource *contentSource = 
        [[AVPictureInPictureControllerContentSource alloc] 
            initWithSampleBufferDisplayLayer:self.sampleBufferLayer
            playbackDelegate:self];
    
    self.pipController = [[AVPictureInPictureController alloc] initWithContentSource:contentSource];
    self.pipController.delegate = (id<AVPictureInPictureControllerDelegate>)self;
    
    NSLog(@"VLCPiPPlayer: PiP controller configured");
}

#pragma mark - Public Properties

- (BOOL)isPiPSupported {
    return [AVPictureInPictureController isPictureInPictureSupported];
}

#pragma mark - Playback Control

- (void)setMediaURL:(NSURL *)url {
    if (self.isPlaying) {
        [self stop];
    }

    VLCMedia *media = [VLCMedia mediaWithURL:url];
    self.mediaPlayer.media = media;

    // Reset atomic frame counter
    atomic_store(&_atomicFrameCount, 0);

    NSLog(@"VLCPiPPlayer: Media set to %@", url);
}

- (void)play {
    [self.mediaPlayer play];
    self.isPlaying = YES;
    
    // Start render synchronizer
    [self.renderSynchronizer setRate:1.0 time:kCMTimeZero];
    
    NSLog(@"VLCPiPPlayer: Play");
}

- (void)pause {
    [self.mediaPlayer pause];
    self.isPlaying = NO;
    
    // Pause render synchronizer
    [self.renderSynchronizer setRate:0.0];
    
    NSLog(@"VLCPiPPlayer: Pause");
}

- (void)stop {
    [self.mediaPlayer stop];
    self.isPlaying = NO;

    // Stop render synchronizer
    [self.renderSynchronizer setRate:0.0];

    // Flush sample buffer layer
    [self.sampleBufferLayer flush];

    // Reset atomic frame counter
    atomic_store(&_atomicFrameCount, 0);

    NSLog(@"VLCPiPPlayer: Stop");
}

- (void)seek:(float)position {
    if (position >= 0 && position <= 1) {
        self.mediaPlayer.position = position;
    }
}

#pragma mark - PiP Control

- (BOOL)startPiP {
    if (!self.pipController) {
        NSLog(@"VLCPiPPlayer: PiP controller not available");
        return NO;
    }
    
    if (!self.pipController.isPictureInPicturePossible) {
        NSLog(@"VLCPiPPlayer: PiP not possible right now");
        return NO;
    }
    
    [self.pipController startPictureInPicture];
    return YES;
}

- (void)stopPiP {
    if (self.pipController && self.isPiPActive) {
        [self.pipController stopPictureInPicture];
    }
}

#pragma mark - VLCMediaPlayerDelegate

- (void)mediaPlayerStateChanged:(NSNotification *)notification {
    VLCMediaPlayerState state = self.mediaPlayer.state;
    NSString *stateString = @"unknown";
    
    switch (state) {
        case VLCMediaPlayerStatePlaying:
            stateString = @"playing";
            NSLog(@"VLCPiPPlayer: State - Playing");
            break;
        case VLCMediaPlayerStatePaused:
            stateString = @"paused";
            NSLog(@"VLCPiPPlayer: State - Paused");
            break;
        case VLCMediaPlayerStateStopped:
            stateString = @"stopped";
            NSLog(@"VLCPiPPlayer: State - Stopped");
            break;
        case VLCMediaPlayerStateEnded:
            stateString = @"ended";
            NSLog(@"VLCPiPPlayer: State - Ended");
            if (self.onEnd) {
                self.onEnd(@{});
            }
            break;
        case VLCMediaPlayerStateError:
            stateString = @"error";
            NSLog(@"VLCPiPPlayer: State - Error");
            if (self.onError) {
                self.onError(@{@"message": @"Playback error"});
            }
            break;
        case VLCMediaPlayerStateBuffering:
            stateString = @"buffering";
            break;
        case VLCMediaPlayerStateOpening:
            stateString = @"opening";
            break;
        default:
            break;
    }
    
    if (self.onPlaybackStateChange) {
        self.onPlaybackStateChange(@{@"state": stateString});
    }
}

- (void)mediaPlayerTimeChanged:(NSNotification *)notification {
    if (self.onProgress && self.mediaPlayer) {
        int currentTime = [[self.mediaPlayer time] intValue];
        int duration = [self.mediaPlayer.media.length intValue];
        float position = self.mediaPlayer.position;
        
        self.onProgress(@{
            @"currentTime": @(currentTime),
            @"duration": @(duration),
            @"position": @(position)
        });
    }
}

#pragma mark - AVPictureInPictureSampleBufferPlaybackDelegate

- (BOOL)pictureInPictureControllerIsPlaybackPaused:(AVPictureInPictureController *)pictureInPictureController {
    return !self.isPlaying;
}

- (CMTimeRange)pictureInPictureControllerTimeRangeForPlayback:(AVPictureInPictureController *)pictureInPictureController {
    // Get duration from VLC if available
    if (self.mediaPlayer.media.length.intValue > 0) {
        CMTime duration = CMTimeMake(self.mediaPlayer.media.length.intValue, 1000);
        return CMTimeRangeMake(kCMTimeZero, duration);
    }
    
    // For live streams or unknown duration
    return CMTimeRangeMake(kCMTimeZero, CMTimeMake(INT64_MAX, 1));
}

- (void)pictureInPictureController:(AVPictureInPictureController *)pictureInPictureController 
         didTransitionToRenderSize:(CMVideoDimensions)newRenderSize {
    NSLog(@"VLCPiPPlayer: PiP transitioned to render size %dx%d", newRenderSize.width, newRenderSize.height);
}

- (void)pictureInPictureController:(AVPictureInPictureController *)pictureInPictureController 
                   setPlaying:(BOOL)playing {
    if (playing) {
        [self play];
    } else {
        [self pause];
    }
}

- (void)pictureInPictureController:(AVPictureInPictureController *)pictureInPictureController 
    skipByInterval:(CMTime)skipInterval 
    completionHandler:(void (^)(void))completionHandler {
    
    Float64 seconds = CMTimeGetSeconds(skipInterval);
    int currentTimeMs = self.mediaPlayer.time.intValue;
    int newTimeMs = currentTimeMs + (int)(seconds * 1000);
    
    // Clamp to valid range
    int durationMs = self.mediaPlayer.media.length.intValue;
    if (newTimeMs < 0) newTimeMs = 0;
    if (newTimeMs > durationMs) newTimeMs = durationMs;
    
    self.mediaPlayer.time = [VLCTime timeWithInt:newTimeMs];
    
    if (completionHandler) {
        completionHandler();
    }
}

#pragma mark - AVPictureInPictureControllerDelegate

- (void)pictureInPictureControllerWillStartPictureInPicture:(AVPictureInPictureController *)pictureInPictureController {
    NSLog(@"VLCPiPPlayer: PiP will start");
}

- (void)pictureInPictureControllerDidStartPictureInPicture:(AVPictureInPictureController *)pictureInPictureController {
    self.isPiPActive = YES;
    NSLog(@"VLCPiPPlayer: PiP started");
    if (self.onPiPStateChange) {
        self.onPiPStateChange(@{@"isActive": @YES});
    }
}

- (void)pictureInPictureControllerWillStopPictureInPicture:(AVPictureInPictureController *)pictureInPictureController {
    NSLog(@"VLCPiPPlayer: PiP will stop");
}

- (void)pictureInPictureControllerDidStopPictureInPicture:(AVPictureInPictureController *)pictureInPictureController {
    self.isPiPActive = NO;
    NSLog(@"VLCPiPPlayer: PiP stopped");
    if (self.onPiPStateChange) {
        self.onPiPStateChange(@{@"isActive": @NO});
    }
}

- (void)pictureInPictureController:(AVPictureInPictureController *)pictureInPictureController 
    failedToStartPictureInPictureWithError:(NSError *)error {
    NSLog(@"VLCPiPPlayer: PiP failed to start - %@", error.localizedDescription);
    if (self.onError) {
        self.onError(@{@"message": error.localizedDescription ?: @"PiP failed to start"});
    }
}

@end
