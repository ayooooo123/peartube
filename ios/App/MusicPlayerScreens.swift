import SwiftUI

// MARK: - Mini-player Dock (Rule 1-4, sits above bottom tab bar)

@MainActor
struct MusicDockBar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController

    var body: some View {
        if let track = music.currentTrack {
            VStack(spacing: 0) {
                // Top 2pt violet progress line
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(PTColor.line)
                        Rectangle()
                            .fill(PTColor.brand)
                            .frame(width: geo.size.width * music.progressFraction)
                    }
                }
                .frame(height: 2)

                HStack(spacing: 10) {
                    Button { model.showMusicPlayer = true } label: {
                        HStack(spacing: 10) {
                            SleeveView(hue: track.hue, seed: track.seed, monogram: track.monogramText, cornerRadius: 6)
                                .frame(width: 42, height: 42)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(track.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(PTColor.ink)
                                    .lineLimit(1)
                                Text(subtitleText(for: track))
                                    .font(.caption)
                                    .foregroundStyle(music.pausedForVideo ? PTColor.warn : PTColor.dim)
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open player, \(track.title)")
                    .accessibilityIdentifier("music.dock.open")

                    Button { music.togglePlayPause() } label: {
                        Image(systemName: music.isPlaying ? "pause.fill" : "play.fill")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(PTColor.ink)
                            .frame(width: 40, height: 40)
                    }
                    .accessibilityLabel(music.isPlaying ? "Pause" : "Play")
                    .accessibilityIdentifier("music.dock.play")

                    Button { music.next() } label: {
                        Image(systemName: "forward.fill")
                            .font(.body)
                            .foregroundStyle(PTColor.ink)
                            .frame(width: 38, height: 40)
                    }
                    .accessibilityLabel("Next")
                    .accessibilityIdentifier("music.dock.next")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(PTColor.surface)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("music.dock")
        }
    }

    private func subtitleText(for track: TrackRow) -> String {
        if music.pausedForVideo { return "Paused for a video" }
        if let err = music.errorMessage { return err }
        if music.isBuffering && music.isPlaying { return "Loading…" }
        return "\(track.displayArtist) · \(track.albumTitle)"
    }
}

// MARK: - Full Music Player Screen

@MainActor
struct MusicPlayerScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController
    @Environment(\.dismiss) private var dismiss

    @State private var scrubbing = false
    @State private var scrubMs: Double = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                if let track = music.currentTrack {
                    VStack(spacing: 22) {
                        // Top bar
                        HStack {
                            Button { dismiss() } label: {
                                Image(systemName: "chevron.down")
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(PTColor.ink)
                                    .frame(width: 44, height: 44)
                            }
                            .accessibilityLabel("Close player")
                            .accessibilityIdentifier("music.close")

                            Spacer()

                            VStack(spacing: 2) {
                                Text("Playing from")
                                    .font(.caption2)
                                    .foregroundStyle(PTColor.dim)
                                Text(music.sourceLabel.isEmpty ? track.albumTitle : music.sourceLabel)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(PTColor.ink)
                                    .lineLimit(1)
                            }

                            Spacer()

                            Menu {
                                Button("Stop and clear list", systemImage: "stop.circle", role: .destructive) {
                                    music.stop()
                                    dismiss()
                                }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .foregroundStyle(PTColor.dim)
                                    .frame(width: 44, height: 44)
                            }
                            .accessibilityLabel("Player options")
                        }

                        // Large sleeve
                        SleeveView(hue: track.hue, seed: track.seed, monogram: track.monogramText, cornerRadius: 14)
                            .frame(maxWidth: 300)
                            .padding(.horizontal, 12)

                        // Title, artist, state
                        VStack(spacing: 5) {
                            Text(track.title)
                                .font(.title2.weight(.bold))
                                .foregroundStyle(PTColor.ink)
                                .multilineTextAlignment(.center)
                                .accessibilityIdentifier("music.title")
                            Text("\(track.displayArtist) · \(track.albumTitle)")
                                .font(.subheadline)
                                .foregroundStyle(PTColor.dim)
                                .multilineTextAlignment(.center)
                            if music.pausedForVideo {
                                Text("Paused for a video")
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(PTColor.warn)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 4)
                                    .background(PTColor.raised, in: Capsule())
                                    .overlay(Capsule().strokeBorder(PTColor.line, lineWidth: 1))
                                    .padding(.top, 2)
                                    .accessibilityIdentifier("music.pausedForVideo")
                            }
                            if let err = music.errorMessage {
                                Text(err)
                                    .font(.caption)
                                    .foregroundStyle(PTColor.bad)
                                    .multilineTextAlignment(.center)
                            }
                        }

                        // Seek slider + clocks
                        VStack(spacing: 6) {
                            let maxDuration = max(1, music.durationMs)
                            Slider(
                                value: Binding(
                                    get: { scrubbing ? scrubMs : min(music.positionMs, maxDuration) },
                                    set: { scrubMs = $0 }
                                ),
                                in: 0...maxDuration
                            ) { editing in
                                scrubbing = editing
                                if editing { scrubMs = music.positionMs }
                                else { music.seek(scrubMs) }
                            }
                            .tint(PTColor.brand)
                            .disabled(music.durationMs <= 0)
                            .accessibilityLabel("Playback position")
                            .accessibilityIdentifier("music.seek")

                            HStack {
                                Text(clock(scrubbing ? scrubMs : music.positionMs))
                                Spacer()
                                Text(music.durationMs > 0 ? clock(music.durationMs) : "--:--")
                            }
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(PTColor.dim)
                        }

                        // Transport controls (Rule 15: nothing dimmed without a readable reason)
                        HStack(spacing: 18) {
                            Button { music.toggleShuffle() } label: {
                                Image(systemName: "shuffle")
                                    .font(.title3)
                                    .foregroundStyle(music.shuffle ? PTColor.brand : PTColor.dim)
                                    .frame(width: 44, height: 44)
                            }
                            .accessibilityLabel("Shuffle")
                            .accessibilityValue(music.shuffle ? "On" : "Off")
                            .accessibilityIdentifier("music.shuffle")

                            Button { music.previous() } label: {
                                Image(systemName: "backward.fill")
                                    .font(.title2)
                                    .foregroundStyle(PTColor.ink)
                                    .frame(width: 48, height: 48)
                            }
                            .accessibilityLabel("Previous")
                            .accessibilityIdentifier("music.prev")

                            Button { music.togglePlayPause() } label: {
                                Image(systemName: music.isPlaying ? "pause.fill" : "play.fill")
                                    .font(.title2.weight(.bold))
                                    .foregroundStyle(PTColor.bg)
                                    .frame(width: 64, height: 64)
                                    .background(PTColor.ink, in: Circle())
                            }
                            .accessibilityLabel(music.isPlaying ? "Pause" : "Play")
                            .accessibilityIdentifier("music.play")

                            Button { music.next() } label: {
                                Image(systemName: "forward.fill")
                                    .font(.title2)
                                    .foregroundStyle(PTColor.ink)
                                    .frame(width: 48, height: 48)
                            }
                            .accessibilityLabel("Next")
                            .accessibilityIdentifier("music.next")

                            Button { music.cycleRepeat() } label: {
                                Image(systemName: music.repeatMode.icon)
                                    .font(.title3)
                                    .foregroundStyle(music.repeatMode == .off ? PTColor.dim : PTColor.brand)
                                    .frame(width: 44, height: 44)
                            }
                            .accessibilityLabel("Repeat")
                            .accessibilityValue(music.repeatMode.label)
                            .accessibilityIdentifier("music.repeat")
                        }

                        Text(music.positionLabel)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(PTColor.dim)
                            .accessibilityIdentifier("music.positionLabel")

                        PTDivider()

                        // Up next
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Up next")
                                        .font(.headline)
                                        .foregroundStyle(PTColor.ink)
                                    Text("Playing from \(music.sourceLabel.isEmpty ? track.albumTitle : music.sourceLabel)")
                                        .font(.caption)
                                        .foregroundStyle(PTColor.dim)
                                }
                                Spacer()
                                if !music.upNextTracks.isEmpty {
                                    Button("Clear") { music.clearUpNext() }
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(PTColor.dim)
                                        .accessibilityIdentifier("music.clearUpNext")
                                }
                            }

                            if music.upNextTracks.isEmpty {
                                Text("Nothing else is lined up after this track.")
                                    .font(.subheadline)
                                    .foregroundStyle(PTColor.dim)
                                    .padding(.vertical, 8)
                            } else {
                                LazyVStack(spacing: 0) {
                                    ForEach(music.upNextTracks, id: \.orderIndex) { item in
                                        HStack(spacing: 12) {
                                            Button { music.playOrderIndex(item.orderIndex) } label: {
                                                HStack(spacing: 12) {
                                                    SleeveView(hue: item.track.hue, seed: item.track.seed, monogram: item.track.monogramText, cornerRadius: 6)
                                                        .frame(width: 38, height: 38)
                                                    VStack(alignment: .leading, spacing: 2) {
                                                        Text(item.track.title)
                                                            .font(.subheadline)
                                                            .foregroundStyle(PTColor.ink)
                                                            .lineLimit(1)
                                                        Text(item.track.displayArtist)
                                                            .font(.caption)
                                                            .foregroundStyle(PTColor.dim)
                                                            .lineLimit(1)
                                                    }
                                                    Spacer()
                                                }
                                                .padding(.vertical, 8)
                                                .contentShape(Rectangle())
                                            }
                                            .buttonStyle(.plain)

                                            Button { music.removeFromQueue(atOrderIndex: item.orderIndex) } label: {
                                                Image(systemName: "xmark")
                                                    .font(.caption.weight(.semibold))
                                                    .foregroundStyle(PTColor.dim)
                                                    .frame(width: 34, height: 38)
                                            }
                                            .accessibilityLabel("Remove \(item.track.title) from Up next")
                                            .accessibilityIdentifier("music.remove.\(item.orderIndex)")
                                        }
                                        PTDivider()
                                    }
                                }
                            }
                        }
                    }
                    .padding(20)
                } else {
                    VStack(spacing: 16) {
                        Text("Nothing is playing.")
                            .foregroundStyle(PTColor.dim)
                        Button("Close player") { dismiss() }
                            .buttonStyle(PTQuietButtonStyle())
                    }
                    .padding(32)
                }
            }
            .background(PTColor.bg)
        }
    }
}
