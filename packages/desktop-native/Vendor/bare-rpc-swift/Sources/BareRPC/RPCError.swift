import Foundation

public struct RPCRemoteError: Error {
  public let message: String
  public let code: String
  public let errno: Int

  public init(message: String, code: String, errno: Int = 0) {
    self.message = message
    self.code = code
    self.errno = errno
  }
}
