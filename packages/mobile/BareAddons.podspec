Pod::Spec.new do |s|
  s.name         = "BareAddons"
  s.version      = "1.0.0"
  s.summary      = "Native addons for Bare worklet (sodium-native, etc.)"
  s.description  = "Pre-built native addon frameworks for use with react-native-bare-kit worklets"
  s.homepage     = "https://github.com/holepunchto"
  s.license      = { :type => "Apache-2.0" }
  s.author       = { "PearTube" => "peartube@example.com" }
  s.platform     = :ios, "15.1"
  s.source       = { :path => "." }

  # Include all prebuilt XCFrameworks (device + simulator)
  s.vendored_frameworks = "Frameworks/*.xcframework"
end
