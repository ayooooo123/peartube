internal import Expo
internal import React
internal import ReactAppDependencyProvider

@UIApplicationMain
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  // Hand-applied. The pear-runtime-react-native Expo config plugin rewrites bundleURL()
  // during `expo prebuild`, but PearTube commits ios/ and its `ios` npm script never
  // prebuilds, so the plugin would never run on iOS. Copied verbatim from
  // node_modules/pear-runtime-react-native/lib/ota-templates.js. The marker comments
  // below are the plugin's own and must stay byte-exact: a future prebuild reads them to
  // decide whether to replace this block or warn.
  // !!! REMOVE THIS AND ONLY THIS COMMENT IF YOU EDIT !!!
  // pear-runtime-react-native OTA v3
  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    let fallback = Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
      .first!.appendingPathComponent("pear-runtime/ota")
    let bundle = dir.appendingPathComponent("app.bundle")
    guard FileManager.default.fileExists(atPath: bundle.path),
      let data = try? Data(contentsOf: dir.appendingPathComponent("package.json")),
      let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let version = manifest["version"] as? String
    else { return fallback }
    let native =
      (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
    return pearOtaSemVerNewer(version, native) ? bundle : fallback
#endif
  }

  private func pearOtaSemVerNewer(_ a: String, _ b: String) -> Bool {
    func numeric(_ value: Substring) -> Bool {
      return !value.isEmpty && value.utf8.allSatisfy { $0 >= 48 && $0 <= 57 }
    }

    func valid(_ value: Substring) -> Bool {
      return !value.isEmpty && value.utf8.allSatisfy {
        ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) ||
          ($0 >= 97 && $0 <= 122) || $0 == 45
      }
    }

    func parse(_ input: String) -> (core: [Substring], prerelease: [Substring])? {
      let metadata = input.split(
        separator: "+",
        maxSplits: 1,
        omittingEmptySubsequences: false
      )

      if metadata.count == 2 {
        let build = metadata[1].split(separator: ".", omittingEmptySubsequences: false)
        guard build.allSatisfy(valid) else { return nil }
      }

      let release = metadata[0].split(
        separator: "-",
        maxSplits: 1,
        omittingEmptySubsequences: false
      )
      let core = release[0].split(separator: ".", omittingEmptySubsequences: false)
      guard core.count == 3,
        core.allSatisfy({ numeric($0) && ($0.count == 1 || $0.first != "0") })
      else { return nil }

      let prerelease = release.count == 2
        ? release[1].split(separator: ".", omittingEmptySubsequences: false)
        : []
      guard prerelease.allSatisfy({
        valid($0) && (!numeric($0) || $0.count == 1 || $0.first != "0")
      }) else { return nil }

      return (core, prerelease)
    }

    func compareNumeric(_ lhs: Substring, _ rhs: Substring) -> Int {
      if lhs.count != rhs.count { return lhs.count > rhs.count ? 1 : -1 }
      if lhs == rhs { return 0 }
      return lhs.lexicographicallyPrecedes(rhs) ? -1 : 1
    }

    guard let lhs = parse(a), let rhs = parse(b) else { return false }

    for i in 0..<3 {
      let order = compareNumeric(lhs.core[i], rhs.core[i])
      if order != 0 { return order > 0 }
    }

    if lhs.prerelease.isEmpty || rhs.prerelease.isEmpty {
      return lhs.prerelease.isEmpty && !rhs.prerelease.isEmpty
    }

    for i in 0..<min(lhs.prerelease.count, rhs.prerelease.count) {
      let x = lhs.prerelease[i]
      let y = rhs.prerelease[i]
      if x == y { continue }

      let xNumeric = numeric(x)
      let yNumeric = numeric(y)
      if xNumeric && yNumeric { return compareNumeric(x, y) > 0 }
      if xNumeric != yNumeric { return !xNumeric }
      return !x.lexicographicallyPrecedes(y)
    }

    return lhs.prerelease.count > rhs.prerelease.count
  }

  // pear-runtime-react-native OTA v3 end
}
