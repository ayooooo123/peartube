// swift-tools-version: 5.10
// Vendored fork of holepunchto/bare-rpc-swift with RPC converted to an actor
// so concurrent request() writers and receive() removers are serialized by
// actor isolation instead of the ad-hoc RPCGate in the desktop-native app.
import PackageDescription

let package = Package(
  name: "BareRPC",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "BareRPC", targets: ["BareRPC"])
  ],
  dependencies: [
    .package(url: "https://github.com/holepunchto/compact-encoding-swift", branch: "main")
  ],
  targets: [
    .target(
      name: "BareRPC",
      dependencies: [.product(name: "CompactEncoding", package: "compact-encoding-swift")],
      path: "Sources/BareRPC"
    )
  ]
)
