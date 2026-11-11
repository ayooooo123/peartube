import SwiftUI

@MainActor
struct CastScreen: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var pairTarget = ""
    @State private var code = ""
    @State private var input = ""
    @State private var scanner = false
    @State private var pairing = false
    @FocusState private var codeFocused: Bool
    var body: some View {
        NavigationStack {
            List {
                if let pending = model.pendingCast { Section { Text("Play “\(pending.title)” on…").font(.headline); Text("Starting at \(clock(model.pendingCastPosition))").font(.caption).foregroundStyle(.secondary) } }
                if let error = model.error { Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("cast.error"); Button("Dismiss Error") { model.error = nil } } }
                Section("Nearby & Saved Screens") {
                    if model.receivers.isEmpty { Text("Looking for PearTube receivers on your Wi-Fi. You can also pair with a TV URI or QR code.").foregroundStyle(.secondary) }
                    ForEach(model.receivers) { receiver in
                        VStack(alignment: .leading, spacing: 8) {
                            Button {
                                if receiver.paired || receiver.json.string("auth") == "none" { Task { await model.selectReceiver(receiver) } }
                                else { pairTarget = receiver.id }
                            } label: {
                                HStack {
                                    Image(systemName: "tv").font(.title2)
                                    VStack(alignment: .leading) { Text(receiver.name).font(.headline); Text(receiver.json.flag("current") ? "\(receiver.online ? "Online" : "Saved") · \(receiver.paired ? "Paired" : "Needs pairing") · \(receiver.json.string("transport"))" : "Needs update").font(.caption).foregroundStyle(.secondary) }
                                    Spacer(); Image(systemName: "chevron.right")
                                }
                            }.buttonStyle(.plain).disabled(!receiver.json.flag("current")).accessibilityIdentifier("cast.receiver.\(receiver.id)")
                            HStack {
                                if !receiver.paired { Button("Enter TV Code") { pairTarget = receiver.id }.accessibilityIdentifier("cast.code.\(receiver.id)") }
                                if receiver.paired && model.pendingCast != nil {
                                    Button("Play Here") { Task { await model.selectReceiver(receiver) } }.accessibilityIdentifier("cast.play.\(receiver.id)")
                                }
                                Spacer()
                                if receiver.paired { Button("Forget", role: .destructive) { Task { await model.forgetReceiver(receiver.id) } }.accessibilityIdentifier("cast.forget.\(receiver.id)") }
                            }
                        }.padding(.vertical, 6)
                    }
                }
                Section("Six-Character TV Code") {
                    Picker("Screen", selection: $pairTarget) {
                        Text("Choose a nearby screen").tag("")
                        ForEach(model.receivers) { receiver in Text(receiver.name).tag(receiver.id) }
                    }.accessibilityIdentifier("cast.pairTarget")
                    TextField("Six-character code", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled().focused($codeFocused).submitLabel(.done).onSubmit { codeFocused = false }.accessibilityIdentifier("cast.pairCode")
                    Button(pairing ? "Pairing…" : "Pair with TV Code") {
                        pairing = true
                        Task { await model.pairReceiver(id: pairTarget, code: code, address: input); pairing = false }
                    }.disabled((pairTarget.isEmpty && input.isEmpty) || pairing).accessibilityIdentifier("cast.pair")
                }
                Section("Pair by Link / Address") {
                    TextField("Receiver link, or its 64-character key", text: $input, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("cast.pairInput")
                    Button("Connect Receiver") {
                        pairing = true
                        Task { await model.pairURI(input); pairing = false }
                    }.disabled(input.isEmpty || pairing).accessibilityIdentifier("cast.pairURI")
                    Button { scanner = true } label: { Label("Scan TV QR Code", systemImage: "qrcode.viewfinder") }.accessibilityIdentifier("cast.scan")
                }
                if !model.session.isEmpty { Section { Button("Open Remote") { dismiss(); model.showRemote = true }.accessibilityIdentifier("cast.remote") } }
            }.navigationTitle("Cast to a Screen").toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Refresh") { Task { await model.refreshCast() } }.accessibilityIdentifier("cast.refresh") }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("cast.close") }
            }
        }
            .sheet(isPresented: $scanner) { QRScanner { value in scanner = false; Task { await model.pairURI(value) } } }
            .task { await model.refreshCast() }
    }
}

@MainActor
struct RemoteBar: View {
    @ObservedObject var model: AppModel
    var body: some View {
        HStack {
            Button { model.showRemote = true } label: {
                HStack {
                    Image(systemName: "airplayvideo").font(.title2)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.session.object("state").object("entry").string("title")).font(.subheadline.bold()).lineLimit(1)
                        Text("\(model.session.string("receiverName")) · \(model.remoteState.json.string("mode")) · \(clock(model.remoteState.positionMs))").font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }.buttonStyle(.plain).accessibilityIdentifier("cast.remote")
            IconButton(title: model.remoteState.playing ? "Pause on TV" : "Play on TV", icon: model.remoteState.playing ? "pause.fill" : "play.fill", identifier: "remote.bar.pause") { Task { await model.control("togglePlay") } }
        }.padding(.horizontal).padding(.vertical, 10).background(.ultraThinMaterial)
    }
}

@MainActor
struct RemoteScreen: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var scrubbing = false
    @State private var scrub: Double = 0
    @State private var audioIndex = ""
    @State private var subtitleIndex = ""
    @State private var volume: Double = 1
    private var state: PlaybackState { model.remoteState }
    var body: some View {
        NavigationStack {
            List {
                if model.session.isEmpty { Section { Text("No active cast session."); Button("Choose a Screen") { dismiss(); model.chooseCast() } } }
                else {
                    Section("Now Playing on \(model.session.string("receiverName"))") {
                        Text(model.session.object("state").object("entry").string("title")).font(.title3.bold())
                        Text("\(model.session.string("transport")) · \(state.json.string("mode"))").foregroundStyle(.secondary)
                        if !state.error.isEmpty { Text(state.error).foregroundStyle(.red).accessibilityIdentifier("remote.error") }
                        Text("\(clock(state.positionMs)) / \(clock(state.durationMs))").font(.body.monospacedDigit()).accessibilityIdentifier("remote.clock")
                        Slider(value: Binding(get: { scrubbing ? scrub : min(state.positionMs, max(1, state.durationMs)) }, set: { scrub = $0 }), in: 0...max(1, state.durationMs)) { editing in
                            scrubbing = editing
                            if editing { scrub = state.positionMs }
                            else { Task { await model.control("seek", ["positionMs": scrub]) } }
                        }.disabled(state.durationMs <= 0).accessibilityIdentifier("remote.seek")
                        HStack {
                            IconButton(title: "Back 10 seconds", icon: "gobackward.10", identifier: "remote.skipBack") { Task { await model.control("skip", ["deltaMs": -10000]) } }
                            Spacer()
                            IconButton(title: state.playing ? "Pause" : "Play", icon: state.playing ? "pause.fill" : "play.fill", identifier: "remote.pause") { Task { await model.control("togglePlay") } }
                            Spacer()
                            IconButton(title: "Forward 10 seconds", icon: "goforward.10", identifier: "remote.skipForward") { Task { await model.control("skip", ["deltaMs": 10000]) } }
                        }
                    }
                    Section("Audio & Subtitles") {
                        if !state.tracks.filter({ $0.kind == "audio" }).isEmpty {
                            ForEach(state.tracks.filter { $0.kind == "audio" }) { track in Button(track.label) { Task { await model.control("selectAudio", ["stream": track.stream]) } }.accessibilityIdentifier("remote.audio.\(track.stream)") }
                        } else {
                            HStack { TextField("Audio stream index", text: $audioIndex).keyboardType(.numberPad).accessibilityIdentifier("remote.audioIndex"); Button("Select Audio") { if let stream = Int(audioIndex), stream >= 0 { Task { await model.control("selectAudio", ["stream": stream]) } } }.disabled(Int(audioIndex) == nil).accessibilityIdentifier("remote.audio") }
                        }
                        Button("Audio Off") { Task { await model.control("selectAudio", ["stream": -1]) } }.accessibilityIdentifier("remote.audio.off")
                        if !state.tracks.filter({ $0.kind == "subtitle" }).isEmpty {
                            ForEach(state.tracks.filter { $0.kind == "subtitle" }) { track in Button(track.label) { Task { await model.control("selectSubtitle", ["stream": track.stream]) } }.accessibilityIdentifier("remote.subtitles.\(track.stream)") }
                        } else {
                            HStack { TextField("Subtitle stream index", text: $subtitleIndex).keyboardType(.numberPad).accessibilityIdentifier("remote.subtitleIndex"); Button("Select Subtitle") { if let stream = Int(subtitleIndex), stream >= 0 { Task { await model.control("selectSubtitle", ["stream": stream]) } } }.disabled(Int(subtitleIndex) == nil).accessibilityIdentifier("remote.subtitles") }
                            Text("This receiver does not report track names. Use its stream index or switch subtitles off.").font(.caption).foregroundStyle(.secondary)
                        }
                        Button("Subtitles Off") { Task { await model.control("selectSubtitle", ["stream": -1]) } }.accessibilityIdentifier("remote.subtitles.off")
                    }
                    if state.json["volume"] is NSNumber || state.json["muted"] is NSNumber {
                        Section("Volume") {
                            Slider(value: $volume, in: 0...1) { editing in if !editing { Task { await model.control("volume", ["volume": volume]) } } }.accessibilityIdentifier("remote.volume")
                            Button(state.json.flag("muted") ? "Unmute" : "Mute") { Task { await model.control("volume", ["muted": !state.json.flag("muted")]) } }.accessibilityIdentifier("remote.mute")
                        }
                    }
                    Section("Playback Location") {
                        Button("Switch to This Phone") { Task { await model.transferBack() } }.accessibilityIdentifier("remote.switchLocal")
                        Button("Leave Playing on TV (Detach)") { Task { await model.stopCast(stopPlayback: false) } }.accessibilityIdentifier("remote.detach")
                        Button("Stop Casting", role: .destructive) { Task { await model.stopCast(stopPlayback: true) } }.accessibilityIdentifier("remote.stop")
                    }
                    Section("Receiver Peer State") {
                        LabeledContent("Peers", value: String(Int(state.json.number("p2pPeers"))))
                        LabeledContent("Cached", value: bytes(state.json.number("cachedBytes")))
                        LabeledContent("Seeding", value: state.json.flag("seeding") ? "Yes" : "No")
                        Text(jsonText(state.json)).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
            }.navigationTitle("TV Remote").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("remote.close") } }
        }
            .onAppear { if state.json["volume"] is NSNumber { volume = state.json.number("volume") } }
            .task { await model.refreshCast() }
    }
}
