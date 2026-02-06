require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "react-native-nitro-vlc"
  s.module_name  = "NitroVLC"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/example/react-native-nitro-vlc"
  s.license      = { :type => "MIT" }
  s.authors      = { "NitroVLC Team" => "team@example.com" }

  s.platforms    = { :ios => "15.1" }
  s.source       = { :path => "." }

  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.exclude_files = "ios/**/*Tests*/**/*"

  s.dependency "MobileVLCKit", "~> 3.7.0"

  load "nitrogen/generated/ios/NitroVLC+autolinking.rb"
  add_nitrogen_files(s)
end
