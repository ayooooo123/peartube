import Foundation

#if canImport(NitroModules) && canImport(MobileVLCKit)
import NitroModules
import MobileVLCKit

class HybridNitroVLCModule: HybridNitroVLCModuleSpec {
  func getVLCVersion() throws -> String {
    return VLCLibrary.shared().version
  }

  func getView(viewId: String) throws -> (any HybridNitroVLCViewSpec)? {
    return HybridNitroVLCView.lookup(viewId: viewId)
  }
}
#endif
