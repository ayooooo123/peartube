import Foundation
import SwiftUI
import UIKit
import AVFoundation

@MainActor
final class NativePlayer: ObservableObject {
    @Published private(set) var state = PlaybackState()
    @Published private(set) var entry: MediaEntry?
    private let keepScreenAwake: Bool
    private var handle: OpaquePointer?
    private var lastState: String?
    private weak var view: PlayerUIView?
    private var pendingPosition: Double?
    private var pendingPaused = false
    private var suspended = false
    private var wasPlaying = false
    private var soundfont: String?
    private var interruption: NSObjectProtocol?
    private var routeChange: NSObjectProtocol?

    init(keepScreenAwake: Bool = true) {
        self.keepScreenAwake = keepScreenAwake
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.uintValue ?? 0
            Task { @MainActor in
                if type == AVAudioSession.InterruptionType.began.rawValue { self?.suspend() }
                else if options & AVAudioSession.InterruptionOptions.shouldResume.rawValue != 0 { self?.resume() }
            }
        }
        routeChange = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
            if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { Task { @MainActor in self?.pause() } }
        }
    }

    func attach(_ view: PlayerUIView) {
        guard self.view !== view else { return }
        retire()
        self.view = view
        if entry != nil { openAttached() }
    }
    func detach(_ view: PlayerUIView) {
        guard self.view === view else { return }
        if entry != nil { pendingPosition = state.positionMs; pendingPaused = !state.playing }
        retire(); self.view = nil
    }
    func open(_ entry: MediaEntry, at position: Double, paused: Bool = false, soundfont: String?) {
        retire()
        self.entry = entry; self.soundfont = soundfont; pendingPosition = max(0, position); pendingPaused = paused
        state = PlaybackState()
        if view != nil { openAttached() }
    }
    private func openAttached() {
        guard let view, let entry else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: keepScreenAwake ? .moviePlayback : .default)
            try session.setActive(true)
        } catch { state = PlaybackState(json: ["error": error.localizedDescription]); return }
        handle = peartube_player_create(Unmanaged.passUnretained(view).toOpaque())
        guard let handle else { bridgeError(); return }
        let result: Int32 = entry.streamURL.withCString { url in
            if let soundfont { return soundfont.withCString { peartube_player_open(handle, url, $0) } }
            return peartube_player_open(handle, url, nil)
        }
        if result < 0 { bridgeError(); return }
        resize(view.bounds.size)
        if pendingPaused { check(peartube_player_pause(handle)) }
        if suspended { check(peartube_player_suspend(handle)) }
        if keepScreenAwake { UIApplication.shared.isIdleTimerDisabled = !suspended }
    }
    func resize(_ size: CGSize) {
        if let handle { check(peartube_player_frame(handle, Double(size.width), Double(size.height))) }
    }
    func poll() {
        guard let handle else { return }
        guard let text = peartube_player_state(handle) else { bridgeError(); return }
        defer { peartube_player_string_free(text) }
        let encoded = String(cString: text)
        guard encoded != lastState else { return }
        let data = Data(encoded.utf8)
        do {
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AppFailure("The player returned invalid state.") }
            state = PlaybackState(json: json)
            lastState = encoded
            if let position = pendingPosition, !state.tracks.isEmpty {
                pendingPosition = nil
                if position > 0 { check(peartube_player_seek(handle, Int64(position))) }
                if pendingPaused { check(peartube_player_pause(handle)) }
            }
        } catch { state = PlaybackState(json: ["error": error.localizedDescription]) }
    }
    func play() { if let handle { check(peartube_player_play(handle)) }; pendingPaused = false; poll() }
    func pause() { if let handle { check(peartube_player_pause(handle)) }; pendingPaused = true; wasPlaying = false; poll() }
    func toggle() { state.playing ? pause() : play() }
    func seek(_ ms: Double) { if let handle { check(peartube_player_seek(handle, Int64(max(0, ms)))) }; poll() }
    func skip(_ ms: Double) { seek(max(0, state.positionMs + ms)) }
    func audio(_ stream: Int) { if let handle { check(peartube_player_select_audio(handle, Int32(stream))) }; poll() }
    func subtitle(_ stream: Int) { if let handle { check(peartube_player_select_subtitle(handle, Int32(stream))) }; poll() }
    func suspend() {
        guard !suspended else { return }
        wasPlaying = state.playing; suspended = true
        if let handle { check(peartube_player_suspend(handle)) }
        if keepScreenAwake { UIApplication.shared.isIdleTimerDisabled = false }
    }
    func resume() {
        guard suspended else { return }
        suspended = false
        if let handle {
            check(peartube_player_resume(handle))
            if !wasPlaying { check(peartube_player_pause(handle)) }
        }
        if keepScreenAwake { UIApplication.shared.isIdleTimerDisabled = entry != nil }
    }
    func close(deactivateAudioSession: Bool = true) {
        retire(); entry = nil; state = PlaybackState(); pendingPosition = nil; suspended = false
        if deactivateAudioSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
    private func retire() {
        lastState = nil
        if let handle { self.handle = nil; peartube_player_destroy(handle) }
        if keepScreenAwake { UIApplication.shared.isIdleTimerDisabled = false }
    }
    private func check(_ code: Int32) { if code < 0 { bridgeError() } }
    private func bridgeError() {
        guard let text = peartube_player_last_error() else { state = PlaybackState(json: ["error": "Native player failed"]); return }
        defer { peartube_player_string_free(text) }
        state = PlaybackState(json: ["error": String(cString: text)])
    }
}

@MainActor
final class PlayerUIView: UIView {
    weak var player: NativePlayer?
    override func layoutSubviews() { super.layoutSubviews(); player?.resize(bounds.size) }
}
struct PlayerSurface: UIViewRepresentable {
    @ObservedObject var player: NativePlayer
    func makeUIView(context: Context) -> PlayerUIView {
        let view = PlayerUIView(); view.backgroundColor = .black; view.player = player
        view.isAccessibilityElement = true
        view.accessibilityLabel = "Video picture"
        view.accessibilityIdentifier = "player.surface"
        player.attach(view)
        return view
    }
    func updateUIView(_ uiView: PlayerUIView, context: Context) {
        player.resize(uiView.bounds.size)
        uiView.accessibilityValue = "\(clock(player.state.positionMs)) of \(clock(player.state.durationMs))"
    }
    static func dismantleUIView(_ uiView: PlayerUIView, coordinator: ()) { uiView.player?.detach(uiView) }
}
