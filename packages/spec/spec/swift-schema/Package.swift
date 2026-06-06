// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "Schema",
  platforms: [.macOS(.v11), .iOS(.v14)],
  products: [
    .library(name: "Schema", targets: ["Schema"])
  ],
  dependencies: [
    .package(url: "https://github.com/holepunchto/compact-encoding-swift", branch: "main")
  ],
  targets: [
    .target(
      name: "Schema",
      dependencies: [.product(name: "CompactEncoding", package: "compact-encoding-swift")],
      path: "Sources"
    )
  ]
)
