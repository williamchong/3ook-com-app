import ExpoModulesCore
import AVFoundation

public class AudioInterruptionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AudioInterruption")

    Events("onInterruptionBegan", "onInterruptionEnded")

    OnStartObserving {
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.handleInterruption(_:)),
        name: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance()
      )
    }

    OnStopObserving {
      NotificationCenter.default.removeObserver(
        self,
        name: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance()
      )
    }
  }

  @objc private func handleInterruption(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
      let typeRaw = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else {
      return
    }

    switch type {
    case .began:
      sendEvent("onInterruptionBegan", [:])
    case .ended:
      var shouldResume = false
      if let optionsRaw = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
        let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
        shouldResume = options.contains(.shouldResume)
      }
      sendEvent("onInterruptionEnded", ["shouldResume": shouldResume])
    @unknown default:
      break
    }
  }
}
