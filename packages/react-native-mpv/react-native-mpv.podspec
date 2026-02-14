require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'react-native-mpv'
  s.module_name = 'ReactNativeMPV'
  s.version = package['version']
  s.summary = package['description']
  s.homepage = 'https://github.com/holepunchto/peartube'
  s.license = { :type => 'MIT' }
  s.authors = { 'PearTube Team' => 'dev@peartube.local' }

  s.platforms = { :ios => '15.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.swift_version = '5.0'

  s.dependency 'React-Core'
end
