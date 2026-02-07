#import <React/RCTViewManager.h>
#import <React/RCTBridge.h>

/// Plain RCTViewManager for the NitroVLCView.
///
/// This replaces the Nitrogen-generated HybridNitroVLCViewComponent.mm Fabric
/// component, using RN's Fabric interop layer (automatic on RN 0.76+) instead
/// of Fabric's ConcreteState/CachedProp/BorrowingReference machinery.
///
/// Only `viewId` is passed as a prop — all other configuration is done
/// imperatively via NitroVLCModule.getView(viewId) from JavaScript.
@interface NitroVLCViewManager : RCTViewManager
@end

@implementation NitroVLCViewManager

RCT_EXPORT_MODULE(NitroVLCView)

- (UIView *)view
{
  // NitroVLCContainerView is defined in Swift. The @objc(NitroVLCContainerView)
  // annotation makes it visible to ObjC via NSClassFromString.
  Class containerClass = NSClassFromString(@"NitroVLCContainerView");
  if (containerClass) {
    return [[containerClass alloc] initWithFrame:CGRectZero];
  }
  // Fallback: should never happen if the Swift class is properly compiled
  return [[UIView alloc] initWithFrame:CGRectZero];
}

RCT_CUSTOM_VIEW_PROPERTY(viewId, NSString, UIView)
{
  NSString *viewId = [RCTConvert NSString:json];
  if ([view respondsToSelector:@selector(setViewId:)]) {
    [view performSelector:@selector(setViewId:) withObject:viewId ?: @""];
  }
}

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

@end
