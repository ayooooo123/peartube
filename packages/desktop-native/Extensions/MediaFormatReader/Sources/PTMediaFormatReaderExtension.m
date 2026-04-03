#import <CoreMedia/CMTime.h>
#import <Foundation/Foundation.h>
#import <MediaExtension/MediaExtension.h>

static NSError *PTMediaExtensionUnsupportedFeatureError(NSString *description) {
  return [NSError errorWithDomain:MediaExtensionErrorDomain
                             code:MEErrorUnsupportedFeature
                         userInfo:@{NSLocalizedDescriptionKey: description}];
}

@interface PTMediaFormatReader : NSObject <MEFormatReader>

@property (nonatomic, retain) MEByteSource *primaryByteSource;

- (instancetype)initWithByteSource:(MEByteSource *)primaryByteSource;

@end

@interface PTMediaFormatReaderExtension : NSObject <MEFormatReaderExtension>
@end

@implementation PTMediaFormatReaderExtension

- (id<MEFormatReader>)formatReaderWithByteSource:(MEByteSource *)primaryByteSource
                                         options:(MEFormatReaderInstantiationOptions *)options
                                           error:(NSError * _Nullable __autoreleasing *)error {
  (void) options;

  NSString *extension = primaryByteSource.fileName.pathExtension.lowercaseString;
  NSSet<NSString *> *supportedExtensions = [NSSet setWithArray:@[@"webm", @"mkv"]];

  if (![supportedExtensions containsObject:extension]) {
    if (error != NULL) {
      *error = PTMediaExtensionUnsupportedFeatureError(
        [NSString stringWithFormat:@"PearTube Media Format Reader only handles experimental WebM/Matroska assets, not '.%@'.", extension]
      );
    }
    return nil;
  }

  return [[PTMediaFormatReader alloc] initWithByteSource:primaryByteSource];
}

@end

@implementation PTMediaFormatReader

- (instancetype)initWithByteSource:(MEByteSource *)primaryByteSource {
  self = [super init];
  if (self == nil) return nil;

  _primaryByteSource = primaryByteSource;
  return self;
}

- (void)loadFileInfoWithCompletionHandler:(void (^)(MEFileInfo * _Nullable, NSError * _Nullable))completionHandler {
  MEFileInfo *info = [MEFileInfo new];
  info.duration = kCMTimeInvalid;
  info.fragmentsStatus = MEFileInfoCouldNotContainFragments;
  completionHandler(info, nil);
}

- (void)loadMetadataWithCompletionHandler:(void (^)(NSArray<AVMetadataItem *> * _Nullable, NSError * _Nullable))completionHandler {
  completionHandler(@[], nil);
}

- (void)loadTrackReadersWithCompletionHandler:(void (^)(NSArray<id<METrackReader>> * _Nullable, NSError * _Nullable))completionHandler {
  completionHandler(
    nil,
    PTMediaExtensionUnsupportedFeatureError(
      @"PearTube Media Format Reader is registered and visible to AVFoundation, but FFmpeg-backed packet extraction is not wired yet."
    )
  );
}

@end
