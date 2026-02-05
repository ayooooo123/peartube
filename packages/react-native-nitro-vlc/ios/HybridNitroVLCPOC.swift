import Foundation

#if canImport(NitroModules) && canImport(MobileVLCKit)
import NitroModules
import MobileVLCKit

class HybridNitroVLCPOC: HybridNitroVLCPOCSpec {
  func getVLCVersion() throws -> String {
    return VLCLibrary.shared().version
  }
}
#endif
