// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "HRPC",
  platforms: [.macOS(.v11), .iOS(.v14)],
  products: [
    .library(name: "HRPC", targets: ["HRPC"])
  ],
  dependencies: [
    .package(url: "https://github.com/holepunchto/bare-rpc-swift", branch: "main"),
    .package(path: "../swift-schema")
  ],
  targets: [
    .target(
      name: "HRPC",
      dependencies: [
        .product(name: "BareRPC", package: "bare-rpc-swift"),
        .product(name: "Schema", package: "swift-schema")
      ],
      path: "Sources"
    )
  ]
)
