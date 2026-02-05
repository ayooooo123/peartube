import Foundation

#if canImport(UIKit)
import UIKit

final class NitroVLCView: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    contentMode = .scaleAspectFit
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    backgroundColor = .clear
    contentMode = .scaleAspectFit
  }
}
#endif
