import SwiftUI

@MainActor
struct PlayerScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var player: NativePlayer
    @State private var controls = true
    @State private var scrubbing = false
    @State private var scrub: Double = 0
    @State private var info = false
    @State private var hideTask: Task<Void, Never>?
    private var entry: MediaEntry? { player.entry }
    var body: some View {
        ZStack {
            PlayerSurface(player: player).ignoresSafeArea()
            Color.clear.contentShape(Rectangle()).ignoresSafeArea().onTapGesture { reveal() }
            if player.state.buffering && player.state.error.isEmpty { ProgressView().tint(.white).accessibilityIdentifier("player.buffering") }
            if !player.state.error.isEmpty {
                Text(player.state.error).foregroundStyle(PTColor.bad).padding().background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 12)).padding().accessibilityIdentifier("player.error")
            }
            if controls || !player.state.playing {
                playbackControls
                    .transition(.opacity)
                    .simultaneousGesture(TapGesture().onEnded { reveal() })
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .sheet(isPresented: $info) {
            PlayerInfoScreen(model: model, player: player)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .onAppear { reveal() }
        .onDisappear { hideTask?.cancel() }
        .onChange(of: player.state.playing) { _, _ in reveal() }
        .onChange(of: info) { _, _ in reveal() }
    }
    private var playbackControls: some View {
        VStack(spacing: 0) {
            HStack {
                IconButton(title: "Back", icon: "chevron.left", identifier: "player.back") { model.closePlayback() }
                Text(entry?.title ?? "").font(.subheadline.bold()).lineLimit(1)
                Spacer(minLength: 0)
                IconButton(title: "File info", icon: "info.circle", identifier: "player.info") { info = true }
                IconButton(title: "Play on a TV", icon: "tv", identifier: "player.cast") { model.chooseCast() }
            }
            Spacer(minLength: 0)
            HStack(spacing: 36) {
                IconButton(title: "Back 10 seconds", icon: "gobackward.10", identifier: "player.skipBack") { player.skip(-10000); reveal() }
                IconButton(title: player.state.ended ? "Play again" : player.state.playing ? "Pause" : "Play", icon: player.state.ended ? "arrow.counterclockwise" : player.state.playing ? "pause.fill" : "play.fill", identifier: "player.pause") {
                    if player.state.ended { player.seek(0); player.play() } else { player.toggle() }
                    reveal()
                }
                IconButton(title: "Forward 10 seconds", icon: "goforward.10", identifier: "player.skipForward") { player.skip(10000); reveal() }
            }
            Spacer(minLength: 0)
            VStack(spacing: 0) {
                Slider(value: Binding(get: { scrubbing ? scrub : min(player.state.positionMs, max(1, player.state.durationMs)) }, set: { scrub = $0 }), in: 0...max(1, player.state.durationMs)) { editing in
                    scrubbing = editing
                    if editing { scrub = player.state.positionMs; hideTask?.cancel() }
                    else { player.seek(scrub); reveal() }
                }
                .tint(PTColor.brand)
                .disabled(player.state.durationMs <= 0)
                .accessibilityIdentifier("player.seek")
                .accessibilityLabel("Playback position")
                HStack {
                    Text("\(scrubbing ? clock(scrub) : clock(player.state.positionMs)) / \(clock(player.state.durationMs))")
                        .font(.caption.monospacedDigit())
                        .accessibilityIdentifier("player.clock")
                        .accessibilityLabel("Playback clock \(clock(player.state.positionMs)) / \(clock(player.state.durationMs))")
                        .accessibilityValue("\(Int(player.state.positionMs)) milliseconds of \(Int(player.state.durationMs)) milliseconds")
                    Spacer()
                    audioMenu
                    subtitleMenu
                }
            }
        }
        .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 20)
        .foregroundStyle(.white)
        .background(LinearGradient(colors: [.black.opacity(0.65), .clear, .black.opacity(0.75)], startPoint: .top, endPoint: .bottom))
    }
    private var audioMenu: some View {
        Menu {
            Button("Audio Off") { player.audio(-1) }
            ForEach(player.state.tracks.filter { $0.kind == "audio" }) { track in
                Button { player.audio(track.stream) } label: { if Int(player.state.json.number("audio")) == track.stream && player.state.json["audio"] is NSNumber { Label(track.label, systemImage: "checkmark") } else { Text(track.label) } }
            }
        } label: { Image(systemName: "speaker.wave.2").frame(width: 44, height: 44) }.accessibilityLabel("Audio").accessibilityIdentifier("player.audio")
    }
    private var subtitleMenu: some View {
        Menu {
            Button("Subtitles Off") { player.subtitle(-1) }
            ForEach(player.state.tracks.filter { $0.kind == "subtitle" }) { track in
                Button { player.subtitle(track.stream) } label: { if Int(player.state.json.number("subtitle")) == track.stream && player.state.json["subtitle"] is NSNumber { Label(track.label, systemImage: "checkmark") } else { Text(track.label) } }
            }
        } label: { Image(systemName: "captions.bubble").frame(width: 44, height: 44) }.accessibilityLabel("Subtitles").accessibilityIdentifier("player.subtitles")
    }
    private func reveal() {
        controls = true; hideTask?.cancel()
        guard player.state.playing, !scrubbing, !info else { return }
        hideTask = Task {
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            if player.state.playing && !scrubbing && !info { withAnimation { controls = false } }
        }
    }
}

@MainActor
struct PlayerInfoScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var player: NativePlayer
    @Environment(\.dismiss) private var dismiss
    @State private var season = ""
    private var formats: [MediaEntry] { model.entries.filter { $0.mediaID == player.entry?.mediaID } }
    private var episodes: [MediaEntry] {
        guard let entry = player.entry, entry.episode != nil else { return [] }
        return Dictionary(grouping: model.entries.filter { $0.groupKey == entry.groupKey }, by: \.mediaID).values.compactMap(\.first).sorted { $0.episodeOrder < $1.episodeOrder }
    }
    private var seasons: [String] { Array(Set(episodes.map(\.season))).sorted() }
    var body: some View {
        NavigationStack {
            List {
                Section("File info") {
                    Text(player.entry?.title ?? "").font(.headline).accessibilityIdentifier("player.info.title")
                    LabeledContent("ID", value: player.entry?.mediaID ?? "")
                    LabeledContent("Size", value: bytes(player.entry?.size ?? 0))
                    LabeledContent("Duration", value: clock(player.state.durationMs))
                    LabeledContent("Picture", value: "\(Int(player.state.json.number("videoWidth"))) × \(Int(player.state.json.number("videoHeight")))")
                    LabeledContent("Decoder", value: player.state.json.string("videoDecoder"))
                    LabeledContent("Dropped Frames", value: String(Int(player.state.json.number("droppedFrames"))))
                    if player.state.durationMs > 0 { LabeledContent("Average Bitrate", value: String(format: "%.2f Mbps", (player.entry?.size ?? 0) * 8 / (player.state.durationMs / 1000) / 1000000)) }
                    if let entry = player.entry {
                        LabeledContent("Source", value: whereLabel(for: entry))
                        LabeledContent("Cached", value: bytes(entry.cachedBytes))
                        Text(entry.source).font(.caption.monospaced()).textSelection(.enabled)
                        if !entry.magnetURL.isEmpty { ShareLink("Share link", item: entry.magnetURL) }
                    }
                }
                Section("Audio") {
                    Button("Audio Off") { player.audio(-1) }.accessibilityIdentifier("player.audio.off")
                    ForEach(player.state.tracks.filter { $0.kind == "audio" }) { track in Button(track.label) { player.audio(track.stream) }.accessibilityIdentifier("player.audio.\(track.stream)") }
                }
                Section("Subtitles") {
                    Button("Subtitles Off") { player.subtitle(-1) }.accessibilityIdentifier("player.subtitles.off")
                    ForEach(player.state.tracks.filter { $0.kind == "subtitle" }) { track in Button(track.label) { player.subtitle(track.stream) }.accessibilityIdentifier("player.subtitles.\(track.stream)") }
                }
                Section("Versions · Keeps Your Position") {
                    ForEach(formats) { format in
                        Button { if format.key != player.entry?.key { model.switchFormat(format) } } label: {
                            HStack { VStack(alignment: .leading) { Text(format.title); Text(bytes(format.size)).font(.caption).foregroundStyle(PTColor.dim) }; Spacer(); if format.key == player.entry?.key { Image(systemName: "checkmark") } }
                        }.accessibilityIdentifier("player.format.\(format.key)")
                    }
                }
                if !episodes.isEmpty {
                    Section("Episodes") {
                        Picker("Season", selection: $season) { ForEach(seasons, id: \.self) { Text($0).tag($0) } }.accessibilityIdentifier("player.seasons")
                        ForEach(episodes.filter { $0.season == (season.isEmpty ? player.entry?.season ?? "" : season) }) { episode in
                            Button { if episode.mediaID != player.entry?.mediaID { model.play(episode, localOnly: true); season = episode.season } } label: {
                                HStack { Text(episode.episode ?? episode.title); Spacer(); Text(bytes(episode.size)).foregroundStyle(PTColor.dim); if episode.mediaID == player.entry?.mediaID { Image(systemName: "play.fill") } }
                            }.accessibilityIdentifier("player.episode.\(episode.key)")
                        }
                    }
                }
                Section("Native Player State") { Text(jsonText(player.state.json)).font(.caption.monospaced()).textSelection(.enabled) }
            }.navigationTitle("File info").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("player.info.close") } }
        }.onAppear { season = player.entry?.season ?? "" }
    }
}
