public struct StreamFlag {
  public static let open: UInt = 0x1
  public static let close: UInt = 0x2
  public static let pause: UInt = 0x4
  public static let resume: UInt = 0x8
  public static let data: UInt = 0x10
  public static let end: UInt = 0x20
  public static let destroy: UInt = 0x40
  public static let error: UInt = 0x80
  public static let request: UInt = 0x100
  public static let response: UInt = 0x200
}
