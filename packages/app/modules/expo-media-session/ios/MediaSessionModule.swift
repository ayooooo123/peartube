import ExpoModulesCore
import AVFoundation
import AVKit
import MediaPlayer

public class MediaSessionModule: Module {
    private var isSessionActive = false
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?
    
    public func definition() -> ModuleDefinition {
        Name("MediaSession")
        
        Events("onRemoteCommand", "onAudioInterruption", "onAudioRouteChange")
        
        AsyncFunction("setActive") { (active: Bool, promise: Promise) in
            self.setSessionActive(active, promise: promise)
        }
        
        AsyncFunction("setNowPlaying") { (metadata: [String: Any], promise: Promise) in
            self.updateNowPlaying(metadata: metadata, promise: promise)
        }
        
        AsyncFunction("setPlaybackState") { (state: [String: Any], promise: Promise) in
            self.updatePlaybackState(state: state, promise: promise)
        }
        
        AsyncFunction("clearNowPlaying") { (promise: Promise) in
            self.clearNowPlayingInfo(promise: promise)
        }
        
        AsyncFunction("isPictureInPictureSupported") { (promise: Promise) in
            if #available(iOS 15.0, *) {
                // Audio session must be configured for playback before
                // isPictureInPictureSupported() returns true.
                let session = AVAudioSession.sharedInstance()
                if session.category != .playback {
                    try? session.setCategory(.playback, mode: .default, options: [])
                }
                promise.resolve(AVPictureInPictureController.isPictureInPictureSupported())
            } else {
                promise.resolve(false)
            }
        }
        
        OnDestroy {
            self.cleanup()
        }
    }
    
    private func setSessionActive(_ active: Bool, promise: Promise) {
        let audioSession = AVAudioSession.sharedInstance()
        
        do {
            if active {
                try audioSession.setCategory(.playback, mode: .default, options: [])
                try audioSession.setActive(true)
                setupRemoteCommands()
                setupNotificationObservers()
                isSessionActive = true
            } else {
                try audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                teardownRemoteCommands()
                teardownNotificationObservers()
                isSessionActive = false
            }
            promise.resolve(nil)
        } catch {
            promise.reject("AUDIO_SESSION_ERROR", "Failed to set audio session active: \(error.localizedDescription)")
        }
    }
    
    private func updateNowPlaying(metadata: [String: Any], promise: Promise) {
        var nowPlayingInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        
        if let title = metadata["title"] as? String {
            nowPlayingInfo[MPMediaItemPropertyTitle] = title
        }
        if let artist = metadata["artist"] as? String {
            nowPlayingInfo[MPMediaItemPropertyArtist] = artist
        }
        if let album = metadata["album"] as? String {
            nowPlayingInfo[MPMediaItemPropertyAlbumTitle] = album
        }
        if let duration = metadata["duration"] as? Double {
            nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = duration
        }
        
        if let artworkUrl = metadata["artworkUrl"] as? String, let url = URL(string: artworkUrl) {
            DispatchQueue.global(qos: .userInitiated).async {
                if let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                    let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    DispatchQueue.main.async {
                        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
                        info[MPMediaItemPropertyArtwork] = artwork
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                    }
                }
            }
        }
        
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
        promise.resolve(nil)
    }
    
    private func updatePlaybackState(state: [String: Any], promise: Promise) {
        var nowPlayingInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        
        if let position = state["position"] as? Double {
            nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        }
        if let duration = state["duration"] as? Double {
            nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = duration
        }
        if let rate = state["rate"] as? Double {
            nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = rate
        }
        if let isPlaying = state["isPlaying"] as? Bool {
            nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? (state["rate"] as? Double ?? 1.0) : 0.0
        }
        
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
        promise.resolve(nil)
    }
    
    private func clearNowPlayingInfo(promise: Promise) {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        promise.resolve(nil)
    }
    
    private func setupRemoteCommands() {
        let commandCenter = MPRemoteCommandCenter.shared()
        
        commandCenter.playCommand.isEnabled = true
        commandCenter.playCommand.addTarget { [weak self] _ in
            self?.sendEvent("onRemoteCommand", ["command": "play"])
            return .success
        }
        
        commandCenter.pauseCommand.isEnabled = true
        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.sendEvent("onRemoteCommand", ["command": "pause"])
            return .success
        }
        
        commandCenter.togglePlayPauseCommand.isEnabled = true
        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.sendEvent("onRemoteCommand", ["command": "togglePlayPause"])
            return .success
        }
        
        commandCenter.stopCommand.isEnabled = true
        commandCenter.stopCommand.addTarget { [weak self] _ in
            self?.sendEvent("onRemoteCommand", ["command": "stop"])
            return .success
        }
        
        commandCenter.skipForwardCommand.isEnabled = true
        commandCenter.skipForwardCommand.preferredIntervals = [10]
        commandCenter.skipForwardCommand.addTarget { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 10
            self?.sendEvent("onRemoteCommand", ["command": "skipForward", "interval": interval])
            return .success
        }
        
        commandCenter.skipBackwardCommand.isEnabled = true
        commandCenter.skipBackwardCommand.preferredIntervals = [10]
        commandCenter.skipBackwardCommand.addTarget { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 10
            self?.sendEvent("onRemoteCommand", ["command": "skipBackward", "interval": interval])
            return .success
        }
        
        commandCenter.changePlaybackPositionCommand.isEnabled = true
        commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            if let positionEvent = event as? MPChangePlaybackPositionCommandEvent {
                self?.sendEvent("onRemoteCommand", ["command": "seekTo", "position": positionEvent.positionTime])
            }
            return .success
        }
        
        commandCenter.nextTrackCommand.isEnabled = false
        commandCenter.previousTrackCommand.isEnabled = false
    }
    
    private func teardownRemoteCommands() {
        let commandCenter = MPRemoteCommandCenter.shared()
        
        commandCenter.playCommand.removeTarget(nil)
        commandCenter.pauseCommand.removeTarget(nil)
        commandCenter.togglePlayPauseCommand.removeTarget(nil)
        commandCenter.stopCommand.removeTarget(nil)
        commandCenter.skipForwardCommand.removeTarget(nil)
        commandCenter.skipBackwardCommand.removeTarget(nil)
        commandCenter.changePlaybackPositionCommand.removeTarget(nil)
    }
    
    private func setupNotificationObservers() {
        let nc = NotificationCenter.default
        
        interruptionObserver = nc.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleInterruption(notification)
        }
        
        routeChangeObserver = nc.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleRouteChange(notification)
        }
    }
    
    private func teardownNotificationObservers() {
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }
        if let observer = routeChangeObserver {
            NotificationCenter.default.removeObserver(observer)
            routeChangeObserver = nil
        }
    }
    
    private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }
        
        switch type {
        case .began:
            sendEvent("onAudioInterruption", ["type": "began"])
        case .ended:
            var shouldResume = false
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                shouldResume = options.contains(.shouldResume)
            }
            sendEvent("onAudioInterruption", ["type": "ended", "shouldResume": shouldResume])
        @unknown default:
            break
        }
    }
    
    private func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }
        
        let reasonString: String
        switch reason {
        case .newDeviceAvailable:
            reasonString = "newDeviceAvailable"
        case .oldDeviceUnavailable:
            reasonString = "oldDeviceUnavailable"
            sendEvent("onRemoteCommand", ["command": "pause"])
        case .categoryChange:
            reasonString = "categoryChange"
        case .override:
            reasonString = "override"
        case .wakeFromSleep:
            reasonString = "wakeFromSleep"
        case .noSuitableRouteForCategory:
            reasonString = "noSuitableRouteForCategory"
        case .routeConfigurationChange:
            reasonString = "routeConfigurationChange"
        @unknown default:
            reasonString = "unknown"
        }
        
        sendEvent("onAudioRouteChange", ["reason": reasonString])
    }
    
    private func cleanup() {
        if isSessionActive {
            teardownRemoteCommands()
            teardownNotificationObservers()
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            isSessionActive = false
        }
    }
}
