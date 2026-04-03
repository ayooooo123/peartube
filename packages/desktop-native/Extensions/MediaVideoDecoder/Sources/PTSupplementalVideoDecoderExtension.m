#import <CoreMedia/CMFormatDescription.h>
#import <Foundation/Foundation.h>
#import <MediaExtension/MediaExtension.h>

static NSError *PTSupplementalDecoderUnsupportedFeatureError(NSString *description) {
  return [NSError errorWithDomain:MediaExtensionErrorDomain
                             code:MEErrorUnsupportedFeature
                         userInfo:@{NSLocalizedDescriptionKey: description}];
}

@interface PTSupplementalVideoDecoder : NSObject <MEVideoDecoder>
@end

@interface PTSupplementalVideoDecoderExtension : NSObject <MEVideoDecoderExtension>
@end

@implementation PTSupplementalVideoDecoderExtension

- (id<MEVideoDecoder>)videoDecoderWithCodecType:(CMVideoCodecType)codecType
                         videoFormatDescription:(CMVideoFormatDescriptionRef)videoFormatDescription
                     videoDecoderSpecifications:(NSDictionary<NSString *, id> *)videoDecoderSpecifications
             extensionDecoderPixelBufferManager:(MEVideoDecoderPixelBufferManager *)extensionDecoderPixelBufferManager
                                          error:(NSError * _Nullable __autoreleasing *)error {
  (void) videoFormatDescription;
  (void) videoDecoderSpecifications;
  (void) extensionDecoderPixelBufferManager;

  if (codecType != kCMVideoCodecType_VP9 && codecType != kCMVideoCodecType_AV1) {
    if (error != NULL) {
      *error = PTSupplementalDecoderUnsupportedFeatureError(
        @"PearTube Supplemental Video Decoder only advertises VP9 and AV1 experiments."
      );
    }
    return nil;
  }

  return [PTSupplementalVideoDecoder new];
}

@end

@implementation PTSupplementalVideoDecoder

- (BOOL)isReadyForMoreMediaData {
  return YES;
}

- (void)decodeFrameFromSampleBuffer:(CMSampleBufferRef)sampleBuffer
                            options:(MEDecodeFrameOptions *)options
                  completionHandler:(void (^)(CVImageBufferRef _Nullable,
                                              MEDecodeFrameStatus,
                                              NSError * _Nullable))completionHandler {
  (void) sampleBuffer;
  (void) options;
  completionHandler(
    NULL,
    MEDecodeFrameNoStatus,
    PTSupplementalDecoderUnsupportedFeatureError(
      @"PearTube Supplemental Video Decoder is registered, but FFmpeg-backed frame decode is not wired yet."
    )
  );
}

@end
