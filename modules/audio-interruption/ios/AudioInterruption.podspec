require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AudioInterruption'
  s.version        = package['version']
  s.summary        = 'Expo module for iOS audio session interruption events'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'William Chong'
  s.homepage       = 'https://3ook.com'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/expo/expo.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.exclude_files = '*.podspec'
end
