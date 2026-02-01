#import "VLCPiPPlayerManager.h"
#import "VLCPiPPlayer.h"
#import <React/RCTBridge.h>
#import <React/RCTUIManager.h>

@implementation VLCPiPPlayerManager

RCT_EXPORT_MODULE(VLCPiPPlayer)

- (UIView *)view {
    if (@available(iOS 15.0, *)) {
        return [[VLCPiPPlayer alloc] init];
    } else {
        // Return empty view for iOS < 15
        UIView *fallbackView = [[UIView alloc] init];
        fallbackView.backgroundColor = [UIColor blackColor];
        return fallbackView;
    }
}

#pragma mark - Props

RCT_EXPORT_VIEW_PROPERTY(onPiPStateChange, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPlaybackStateChange, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onError, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onProgress, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onLoad, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onEnd, RCTDirectEventBlock)

RCT_CUSTOM_VIEW_PROPERTY(source, NSDictionary, VLCPiPPlayer) {
    if (@available(iOS 15.0, *)) {
        VLCPiPPlayer *player = (VLCPiPPlayer *)view;
        NSString *uri = [json objectForKey:@"uri"];
        if (uri) {
            NSURL *url = [NSURL URLWithString:uri];
            [player setMediaURL:url];
        }
    }
}

RCT_CUSTOM_VIEW_PROPERTY(paused, BOOL, VLCPiPPlayer) {
    if (@available(iOS 15.0, *)) {
        VLCPiPPlayer *player = (VLCPiPPlayer *)view;
        BOOL paused = [json boolValue];
        if (paused) {
            [player pause];
        } else {
            [player play];
        }
    }
}

RCT_CUSTOM_VIEW_PROPERTY(seek, float, VLCPiPPlayer) {
    if (@available(iOS 15.0, *)) {
        VLCPiPPlayer *player = (VLCPiPPlayer *)view;
        float position = [json floatValue];
        [player seek:position];
    }
}

#pragma mark - Methods

RCT_EXPORT_METHOD(startPiP:(nonnull NSNumber *)reactTag) {
    [self.bridge.uiManager addUIBlock:^(RCTUIManager *uiManager, NSDictionary<NSNumber *,UIView *> *viewRegistry) {
        if (@available(iOS 15.0, *)) {
            VLCPiPPlayer *player = (VLCPiPPlayer *)viewRegistry[reactTag];
            if ([player isKindOfClass:[VLCPiPPlayer class]]) {
                [player startPiP];
            } else {
                NSLog(@"VLCPiPPlayerManager: Invalid view for startPiP");
            }
        }
    }];
}

RCT_EXPORT_METHOD(stopPiP:(nonnull NSNumber *)reactTag) {
    [self.bridge.uiManager addUIBlock:^(RCTUIManager *uiManager, NSDictionary<NSNumber *,UIView *> *viewRegistry) {
        if (@available(iOS 15.0, *)) {
            VLCPiPPlayer *player = (VLCPiPPlayer *)viewRegistry[reactTag];
            if ([player isKindOfClass:[VLCPiPPlayer class]]) {
                [player stopPiP];
            } else {
                NSLog(@"VLCPiPPlayerManager: Invalid view for stopPiP");
            }
        }
    }];
}

RCT_EXPORT_METHOD(play:(nonnull NSNumber *)reactTag) {
    [self.bridge.uiManager addUIBlock:^(RCTUIManager *uiManager, NSDictionary<NSNumber *,UIView *> *viewRegistry) {
        if (@available(iOS 15.0, *)) {
            VLCPiPPlayer *player = (VLCPiPPlayer *)viewRegistry[reactTag];
            if ([player isKindOfClass:[VLCPiPPlayer class]]) {
                [player play];
            }
        }
    }];
}

RCT_EXPORT_METHOD(pause:(nonnull NSNumber *)reactTag) {
    [self.bridge.uiManager addUIBlock:^(RCTUIManager *uiManager, NSDictionary<NSNumber *,UIView *> *viewRegistry) {
        if (@available(iOS 15.0, *)) {
            VLCPiPPlayer *player = (VLCPiPPlayer *)viewRegistry[reactTag];
            if ([player isKindOfClass:[VLCPiPPlayer class]]) {
                [player pause];
            }
        }
    }];
}

RCT_EXPORT_METHOD(stop:(nonnull NSNumber *)reactTag) {
    [self.bridge.uiManager addUIBlock:^(RCTUIManager *uiManager, NSDictionary<NSNumber *,UIView *> *viewRegistry) {
        if (@available(iOS 15.0, *)) {
            VLCPiPPlayer *player = (VLCPiPPlayer *)viewRegistry[reactTag];
            if ([player isKindOfClass:[VLCPiPPlayer class]]) {
                [player stop];
            }
        }
    }];
}

@end
