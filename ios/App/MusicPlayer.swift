import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Persisted snapshot of the music queue and switches (`music-state.json`).
struct PersistedMusicState: Codable {
    var queueKeys: [String] = []
    var order: [Int] = []
    var index: Int = 0
    var positionMs: Double = 0
    var sourceLabel: String = ""
    var shuffle: Bool = false
    var repeatMode: RepeatMode = .off
    var pausedForVideo: Bool = false
    var finished: Bool = false
    var updatedAt: Double = 0
}

/// Pure queue state machine implementing Rules 1-4 & 13-15 of `design/unified-library.md`.
/// Kept independent of UIKit/NativePlayer so its transitions are deterministic and unit-testable.
struct MusicQueueEngine {
    var queue: [TrackRow] = []
    var order: [Int] = []
    var index: Int = 0
    var sourceLabel: String = ""
    var shuffle: Bool = false
    var repeatMode: RepeatMode = .off
    var pausedForVideo: Bool = false
    var finished: Bool = false

    var hasQueue: Bool { !queue.isEmpty && order.indices.contains(index) }

    var currentTrack: TrackRow? {
        guard hasQueue else { return nil }
        let qi = order[index]
        return queue.indices.contains(qi) ? queue[qi] : nil
    }

    var upNext: [(orderIndex: Int, track: TrackRow)] {
        guard hasQueue, index + 1 < order.count else { return [] }
        return ((index + 1)..<order.count).compactMap { oi in
            let qi = order[oi]
            guard queue.indices.contains(qi) else { return nil }
            return (orderIndex: oi, track: queue[qi])
        }
    }

    var positionLabel: String {
        guard hasQueue else { return "" }
        return "\(index + 1) of \(order.count)"
    }

    mutating func playTrackList(
        _ tracks: [TrackRow],
        startIndex: Int? = nil,
        sourceLabel: String,
        shuffleOn: Bool? = nil,
        shuffler: (inout [Int]) -> Void = { $0.shuffle() }
    ) -> TrackRow? {
        let playable = tracks.filter { $0.entry.playable }
        guard !playable.isEmpty else { return nil }

        let targetKey: String? = startIndex.flatMap { tracks.indices.contains($0) ? tracks[$0].entry.key : nil }
        let resolvedStart = targetKey.flatMap { key in playable.firstIndex { $0.entry.key == key } }

        queue = playable
        self.sourceLabel = sourceLabel
        if let shuffleOn { shuffle = shuffleOn }
        pausedForVideo = false
        finished = false

        if shuffle {
            var indices = Array(playable.indices)
            if let chosen = resolvedStart {
                indices.removeAll { $0 == chosen }
                shuffler(&indices)
                order = [chosen] + indices
            } else {
                shuffler(&indices)
                order = indices
            }
            index = 0
        } else {
            order = Array(playable.indices)
            index = resolvedStart ?? 0
        }
        return currentTrack
    }

    /// Inserts tracks immediately after the current track (or initializes a paused queue if empty).
    @discardableResult
    mutating func playNext(_ tracks: [TrackRow], sourceLabel: String) -> Int {
        let playable = tracks.filter { $0.entry.playable }
        guard !playable.isEmpty else { return 0 }
        if !hasQueue {
            queue = playable
            order = Array(playable.indices)
            index = 0
            self.sourceLabel = sourceLabel
            pausedForVideo = false
            finished = false
            return playable.count
        }
        let base = queue.count
        queue.append(contentsOf: playable)
        let added = Array(base..<(base + playable.count))
        order.insert(contentsOf: added, at: min(order.count, index + 1))
        finished = false
        return playable.count
    }

    /// Appends tracks at the end of the queue (or initializes a paused queue if empty).
    @discardableResult
    mutating func playLast(_ tracks: [TrackRow], sourceLabel: String) -> Int {
        let playable = tracks.filter { $0.entry.playable }
        guard !playable.isEmpty else { return 0 }
        if !hasQueue {
            queue = playable
            order = Array(playable.indices)
            index = 0
            self.sourceLabel = sourceLabel
            pausedForVideo = false
            finished = false
            return playable.count
        }
        let base = queue.count
        queue.append(contentsOf: playable)
        order.append(contentsOf: base..<(base + playable.count))
        finished = false
        return playable.count
    }

    /// Rule 14: Shuffle is a switch. On mixes tracks after the current one; Off restores list order after the current track.
    mutating func toggleShuffle(shuffler: (inout [Int]) -> Void = { $0.shuffle() }) {
        shuffle.toggle()
        guard hasQueue else { return }
        let currentQI = order[index]
        if shuffle {
            let first = index + 1
            if first < order.count {
                var tail = Array(order[first...])
                let before = tail
                shuffler(&tail)
                if tail.count >= 2 && tail == before {
                    tail.swapAt(0, 1)
                }
                order.replaceSubrange(first..<order.count, with: tail)
            }
        } else {
            // Keep already-played items up through current, then restore remaining queue items in canonical list order
            let remainingSet = Set(order[(index + 1)...])
            let orderedRemaining = queue.indices.filter { remainingSet.contains($0) }
            // Order items after currentQI first, then any earlier remaining items (e.g. if started mid-list shuffled)
            let afterCurrent = orderedRemaining.filter { $0 > currentQI }
            let beforeCurrent = orderedRemaining.filter { $0 < currentQI }
            order = Array(order[0...index]) + afterCurrent + beforeCurrent
        }
    }

    mutating func cycleRepeat() {
        repeatMode = repeatMode.next
    }

    enum StepOutcome: Equatable {
        case play(TrackRow)
        case restartCurrent
        case finished
        case unchanged
    }

    mutating func advanceNext(automatic: Bool) -> StepOutcome {
        guard hasQueue else { return .unchanged }
        if automatic && repeatMode == .one, let current = currentTrack {
            finished = false
            return .play(current)
        }
        if index + 1 < order.count {
            index += 1
            finished = false
            return currentTrack.map(StepOutcome.play) ?? .unchanged
        }
        if repeatMode == .all && !order.isEmpty {
            index = 0
            finished = false
            return currentTrack.map(StepOutcome.play) ?? .unchanged
        }
        if automatic {
            finished = true
            return .finished
        }
        return .unchanged
    }

    mutating func stepPrevious(currentPositionMs: Double, hasError: Bool) -> StepOutcome {
        guard hasQueue else { return .unchanged }
        if index == 0 || (currentPositionMs > 3000 && !hasError) {
            finished = false
            return .restartCurrent
        }
        index -= 1
        finished = false
        return currentTrack.map(StepOutcome.play) ?? .unchanged
    }

    mutating func jump(toOrderIndex orderIndex: Int) -> TrackRow? {
        guard order.indices.contains(orderIndex) else { return nil }
        index = orderIndex
        pausedForVideo = false
        finished = false
        return currentTrack
    }

    mutating func removeFromQueue(atOrderIndex orderIndex: Int) {
        guard orderIndex > index && orderIndex < order.count else { return }
        order.remove(at: orderIndex)
    }

    mutating func clearUpNext() {
        guard hasQueue, index + 1 < order.count else { return }
        order.removeSubrange((index + 1)..<order.count)
    }

    mutating func stop() {
        queue = []
        order = []
        index = 0
        sourceLabel = ""
        pausedForVideo = false
        finished = false
    }

    func snapshot(positionMs: Double, updatedAt: Double) -> PersistedMusicState {
        PersistedMusicState(
            queueKeys: queue.map(\.entry.key),
            order: order,
            index: index,
            positionMs: positionMs,
            sourceLabel: sourceLabel,
            shuffle: shuffle,
            repeatMode: repeatMode,
            pausedForVideo: pausedForVideo,
            finished: finished,
            updatedAt: updatedAt
        )
    }

    mutating func restore(from state: PersistedMusicState, catalog: LibraryCatalog) {
        shuffle = state.shuffle
        repeatMode = state.repeatMode
        guard !state.queueKeys.isEmpty else { return }

        var byKey: [String: TrackRow] = [:]
        for row in catalog.tracks where row.entry.playable {
            byKey[row.entry.key] = row
        }

        // Remap surviving tracks and preserve order/index
        var newQueue: [TrackRow] = []
        var oldToNew: [Int: Int] = [:]
        for (oldIdx, key) in state.queueKeys.enumerated() {
            if let row = byKey[key] {
                oldToNew[oldIdx] = newQueue.count
                newQueue.append(row)
            }
        }
        guard !newQueue.isEmpty else { return }

        let sourceOrder = state.order.isEmpty ? Array(state.queueKeys.indices) : state.order
        var newOrder: [Int] = []
        var newIndex = 0
        var matchedCurrent = false
        for (oi, oldQI) in sourceOrder.enumerated() {
            guard let mapped = oldToNew[oldQI] else { continue }
            if oi == state.index {
                newIndex = newOrder.count
                matchedCurrent = true
            }
            newOrder.append(mapped)
        }
        guard !newOrder.isEmpty else { return }
        if !matchedCurrent { newIndex = min(state.index, newOrder.count - 1) }

        queue = newQueue
        order = newOrder
        index = max(0, min(newIndex, newOrder.count - 1))
        sourceLabel = state.sourceLabel.isEmpty ? newQueue[newOrder[index]].albumTitle : state.sourceLabel
        pausedForVideo = state.pausedForVideo
        finished = state.finished
    }
}

#if canImport(UIKit)
/// Persistent music controller with its own hidden 1x1 `PlayerUIView`-backed `NativePlayer`.
/// Plays audio while browsing any room and coordinates Rules 1-4 with the video player.
@MainActor
final class MusicController: ObservableObject {
    @Published private(set) var queue: [TrackRow] = []
    @Published private(set) var order: [Int] = []
    @Published private(set) var index: Int = 0
    @Published private(set) var sourceLabel: String = ""
    @Published private(set) var shuffle: Bool = false
    @Published private(set) var repeatMode: RepeatMode = .off
    @Published private(set) var pausedForVideo: Bool = false
    @Published private(set) var finished: Bool = false
    @Published private(set) var isPlaying: Bool = false
    @Published private(set) var isBuffering: Bool = false
    @Published private(set) var positionMs: Double = 0
    @Published private(set) var durationMs: Double = 0
    @Published private(set) var errorMessage: String?
    @Published private(set) var updatedAt: Double = 0

    let audioPlayer = NativePlayer(keepScreenAwake: false)
    private let hiddenSurface: PlayerUIView
    private var engine = MusicQueueEngine()
    private var parkedPositionMs: Double = 0
    private var persistedPending: PersistedMusicState?
    private var restored = false
    private var endedHandled = false
    private var lastSavedAt = Date.distantPast

    var onBeforeStartMusic: (() -> Void)?
    var onWarmKey: ((String) -> Void)?
    var soundfontPath: (() -> String?)?
    var onSaveState: ((PersistedMusicState) -> Void)?
    var onNotice: ((String) -> Void)?

    init() {
        let surface = PlayerUIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        surface.isHidden = true
        surface.player = audioPlayer
        hiddenSurface = surface
        audioPlayer.attach(surface)
    }

    var hasQueue: Bool { engine.hasQueue }
    var currentTrack: TrackRow? { engine.currentTrack }
    var upNextTracks: [(orderIndex: Int, track: TrackRow)] { engine.upNext }
    var positionLabel: String { engine.positionLabel }
    var canContinueOnHome: Bool { hasQueue && !finished }

    var progressFraction: Double {
        guard durationMs > 0 else { return 0 }
        return min(1, max(0, positionMs / durationMs))
    }

    func isCurrentTrack(_ key: String) -> Bool {
        currentTrack?.entry.key == key
    }

    func loadPersisted(_ state: PersistedMusicState) {
        engine.shuffle = state.shuffle
        engine.repeatMode = state.repeatMode
        updatedAt = state.updatedAt
        persistedPending = state
        syncPublished()
    }

    func restoreIfNeeded(catalog: LibraryCatalog) {
        guard !restored, !catalog.tracks.isEmpty, let state = persistedPending else { return }
        restored = true
        guard !engine.hasQueue else { return }
        engine.restore(from: state, catalog: catalog)
        if engine.hasQueue {
            parkedPositionMs = max(0, state.positionMs)
            positionMs = parkedPositionMs
            updatedAt = state.updatedAt
        }
        syncPublished()
    }

    func playTrackList(_ tracks: [TrackRow], startIndex: Int? = nil, sourceLabel: String, shuffleOn: Bool? = nil) {
        guard let track = engine.playTrackList(tracks, startIndex: startIndex, sourceLabel: sourceLabel, shuffleOn: shuffleOn) else { return }
        openAndPlay(track, at: 0)
    }

    func playNext(_ tracks: [TrackRow], sourceLabel: String) {
        let count = engine.playNext(tracks, sourceLabel: sourceLabel)
        guard count > 0 else { return }
        syncPublished()
        persist(force: true)
        onNotice?("Added \(plural(count, "track", "tracks")) to Up next")
    }

    func playLast(_ tracks: [TrackRow], sourceLabel: String) {
        let count = engine.playLast(tracks, sourceLabel: sourceLabel)
        guard count > 0 else { return }
        syncPublished()
        persist(force: true)
        onNotice?("Added \(plural(count, "track", "tracks")) to Up next")
    }

    func playOrderIndex(_ orderIndex: Int) {
        guard let track = engine.jump(toOrderIndex: orderIndex) else { return }
        openAndPlay(track, at: 0)
    }

    func togglePlayPause() {
        guard let current = engine.currentTrack else { return }
        if engine.finished {
            if let first = engine.jump(toOrderIndex: 0) {
                openAndPlay(first, at: 0)
            }
            return
        }
        if audioPlayer.entry?.key != current.entry.key || errorMessage != nil {
            openAndPlay(current, at: parkedPositionMs)
            return
        }
        if audioPlayer.state.playing {
            audioPlayer.pause()
            isPlaying = false
            parkedPositionMs = audioPlayer.state.positionMs
            persist(force: true)
        } else {
            onBeforeStartMusic?()
            engine.pausedForVideo = false
            endedHandled = false
            audioPlayer.play()
            isPlaying = true
            updatedAt = Date().timeIntervalSince1970 * 1000
            syncPublished()
            persist(force: true)
        }
    }

    func next() {
        switch engine.advanceNext(automatic: false) {
        case .play(let track):
            if engine.pausedForVideo {
                parkWithoutStarting(track)
            } else {
                openAndPlay(track, at: 0)
            }
        case .restartCurrent, .finished, .unchanged:
            break
        }
    }

    func previous() {
        switch engine.stepPrevious(currentPositionMs: positionMs, hasError: errorMessage != nil) {
        case .restartCurrent:
            seek(0)
        case .play(let track):
            if engine.pausedForVideo {
                parkWithoutStarting(track)
            } else {
                openAndPlay(track, at: 0)
            }
        case .finished, .unchanged:
            break
        }
    }

    func seek(_ ms: Double) {
        guard hasQueue else { return }
        let target = max(0, durationMs > 0 ? min(durationMs, ms) : ms)
        positionMs = target
        parkedPositionMs = target
        if audioPlayer.entry?.key == currentTrack?.entry.key {
            audioPlayer.seek(target)
        }
        persist(force: true)
    }

    func toggleShuffle() {
        engine.toggleShuffle()
        syncPublished()
        persist(force: true)
    }

    func cycleRepeat() {
        engine.cycleRepeat()
        syncPublished()
        persist(force: true)
    }

    func removeFromQueue(atOrderIndex orderIndex: Int) {
        engine.removeFromQueue(atOrderIndex: orderIndex)
        syncPublished()
        persist(force: true)
    }

    func clearUpNext() {
        engine.clearUpNext()
        syncPublished()
        persist(force: true)
    }

    /// Rule 3: Music waits for a video. Keeps track, position, and list; shows `Paused for a video` when video closes.
    func pauseForVideo() {
        guard hasQueue else { return }
        let wasActive = isPlaying || isBuffering || audioPlayer.state.playing || audioPlayer.entry != nil
        guard wasActive else { return }
        if audioPlayer.entry != nil {
            parkedPositionMs = max(parkedPositionMs, audioPlayer.state.positionMs)
            audioPlayer.pause()
        }
        isPlaying = false
        isBuffering = false
        engine.pausedForVideo = true
        syncPublished()
        persist(force: true)
    }

    func stop() {
        audioPlayer.close(deactivateAudioSession: false)
        engine.stop()
        parkedPositionMs = 0
        positionMs = 0
        durationMs = 0
        isPlaying = false
        isBuffering = false
        errorMessage = nil
        endedHandled = false
        syncPublished()
        persist(force: true)
    }

    func poll() {
        guard audioPlayer.entry != nil else { return }
        audioPlayer.poll()
        let st = audioPlayer.state
        let err = st.error.isEmpty ? nil : st.error
        if errorMessage != err { errorMessage = err }
        if isPlaying != st.playing { isPlaying = st.playing }
        if isBuffering != st.buffering { isBuffering = st.buffering }
        if st.positionMs > 0 || st.durationMs > 0 {
            positionMs = st.positionMs
            parkedPositionMs = st.positionMs
            durationMs = st.durationMs
        }
        if st.playing {
            updatedAt = Date().timeIntervalSince1970 * 1000
            persist(force: false)
        }
        if st.ended && !endedHandled && !engine.pausedForVideo {
            endedHandled = true
            switch engine.advanceNext(automatic: true) {
            case .play(let nextTrack):
                openAndPlay(nextTrack, at: 0)
            case .finished:
                isPlaying = false
                syncPublished()
                persist(force: true)
            case .restartCurrent, .unchanged:
                break
            }
        }
    }

    private func openAndPlay(_ track: TrackRow, at position: Double) {
        // Rule 4: Starting music closes any open video (which saves video progress for Keep playing).
        onBeforeStartMusic?()
        engine.pausedForVideo = false
        engine.finished = false
        endedHandled = false
        errorMessage = nil
        parkedPositionMs = max(0, position)
        positionMs = parkedPositionMs
        durationMs = 0
        updatedAt = Date().timeIntervalSince1970 * 1000
        onWarmKey?(track.entry.key)
        audioPlayer.open(track.entry, at: parkedPositionMs, paused: false, soundfont: soundfontPath?())
        isPlaying = true
        isBuffering = true
        syncPublished()
        persist(force: true)
    }

    private func parkWithoutStarting(_ track: TrackRow) {
        audioPlayer.close(deactivateAudioSession: false)
        parkedPositionMs = 0
        positionMs = 0
        durationMs = 0
        isPlaying = false
        isBuffering = false
        errorMessage = nil
        endedHandled = false
        syncPublished()
        persist(force: true)
    }

    private func syncPublished() {
        queue = engine.queue
        order = engine.order
        index = engine.index
        sourceLabel = engine.sourceLabel
        shuffle = engine.shuffle
        repeatMode = engine.repeatMode
        pausedForVideo = engine.pausedForVideo
        finished = engine.finished
    }

    private func persist(force: Bool) {
        let now = Date()
        guard force || now.timeIntervalSince(lastSavedAt) >= 5 else { return }
        lastSavedAt = now
        onSaveState?(engine.snapshot(positionMs: parkedPositionMs, updatedAt: updatedAt))
    }
}
#endif
