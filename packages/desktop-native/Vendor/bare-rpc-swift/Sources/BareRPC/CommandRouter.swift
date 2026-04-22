import Foundation

/// Routes incoming requests and events to per-command handlers.
///
/// Plain composable object, not an `RPCDelegate` — adopters forward dispatch
/// from their own delegate methods. Request handlers return `Data?` to auto-reply;
/// throwing rejects. Unregistered commands fall through to the router's
/// `delegate` (see `CommandRouterDelegate`); the default is to auto-reject
/// unknown requests with `ERR_UNKNOWN_COMMAND` and drop unknown events.
public protocol CommandRouterDelegate: AnyObject {
  func commandRouter(
    _ router: CommandRouter, didReceiveUnknownRequest request: IncomingRequest) async
  func commandRouter(
    _ router: CommandRouter, didReceiveUnknownEvent event: IncomingEvent) async
}

extension CommandRouterDelegate {
  public func commandRouter(
    _ router: CommandRouter, didReceiveUnknownRequest request: IncomingRequest
  ) async {
    request.reject(
      "Unknown command \(request.command)", code: "ERR_UNKNOWN_COMMAND", errno: 0)
  }

  public func commandRouter(
    _ router: CommandRouter, didReceiveUnknownEvent event: IncomingEvent
  ) async {}
}

public final class CommandRouter {
  public typealias RequestHandler = (IncomingRequest) async throws -> Data?
  public typealias EventHandler = (IncomingEvent) async -> Void

  private var requestHandlers: [UInt: RequestHandler] = [:]
  private var eventHandlers: [UInt: EventHandler] = [:]

  public weak var delegate: CommandRouterDelegate?

  public init(delegate: CommandRouterDelegate? = nil) {
    self.delegate = delegate
  }

  public func on(request command: UInt, _ handler: @escaping RequestHandler) {
    requestHandlers[command] = handler
  }

  public func on(event command: UInt, _ handler: @escaping EventHandler) {
    eventHandlers[command] = handler
  }

  public func dispatch(_ request: IncomingRequest) async {
    guard let handler = requestHandlers[request.command] else {
      await defaultUnknownRequest(request)
      return
    }
    do {
      let data = try await handler(request)
      request.reply(data)
    } catch let err as RPCRemoteError {
      request.reject(err.message, code: err.code, errno: err.errno)
    } catch {
      request.reject("Internal error", code: "ERROR", errno: 0)
    }
  }

  public func dispatch(_ event: IncomingEvent) async {
    if let handler = eventHandlers[event.command] {
      await handler(event)
      return
    }
    if let delegate {
      await delegate.commandRouter(self, didReceiveUnknownEvent: event)
    }
  }

  private func defaultUnknownRequest(_ request: IncomingRequest) async {
    if let delegate {
      await delegate.commandRouter(self, didReceiveUnknownRequest: request)
    } else {
      request.reject(
        "Unknown command \(request.command)", code: "ERR_UNKNOWN_COMMAND", errno: 0)
    }
  }
}
