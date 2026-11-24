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
    @State private var forgetTarget: CastReceiver?
    @FocusState private var codeFocused: Bool

    private var activeReceiverID: String { model.session.string("receiverId") }

    private func receiverStatus(_ receiver: CastReceiver) -> (text: String, color: Color) {
        if !receiver.current { return ("Needs an update", PTColor.warn) }
        if !activeReceiverID.isEmpty && activeReceiverID == receiver.id { return ("Playing", PTColor.ok) }
        if receiver.paired || receiver.openAuth { return ("Ready", PTColor.ok) }
        return ("Needs its code", PTColor.dim)
    }

    var body: some View {
        NavigationStack {
            List {
                if let pending = model.pendingCast {
                    Section {
                        Text("Play “\(pending.title)” on…").font(.headline)
                        Text("Starting at \(clock(model.pendingCastPosition))").font(.caption).foregroundStyle(PTColor.dim)
                    }
                }

                if let error = model.error {
                    Section {
                        Text(error).foregroundStyle(PTColor.bad).accessibilityIdentifier("cast.error")
                        Button("Dismiss") { model.error = nil }
                    }
                }

                if !model.session.isEmpty {
                    Section("Playing now") {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(model.session.string("receiverName")).font(.headline)
                                    Text(model.session.object("state").object("entry").string("title"))
                                        .font(.subheadline)
                                        .foregroundStyle(PTColor.dim)
                                        .lineLimit(1)
                                }
                                Spacer()
                                Text(clock(model.remoteState.positionMs))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(PTColor.dim)
                            }
                            HStack(spacing: 16) {
                                IconButton(title: "Back 10 seconds", icon: "gobackward.10", identifier: "cast.inline.skipBack") {
                                    Task { await model.control("skip", ["deltaMs": -10000]) }
                                }
                                IconButton(title: model.remoteState.playing ? "Pause" : "Play", icon: model.remoteState.playing ? "pause.fill" : "play.fill", identifier: "cast.inline.pause") {
                                    Task { await model.control("togglePlay") }
                                }
                                IconButton(title: "Forward 10 seconds", icon: "goforward.10", identifier: "cast.inline.skipForward") {
                                    Task { await model.control("skip", ["deltaMs": 10000]) }
                                }
                                Spacer()
                                Button("Stop", role: .destructive) {
                                    Task { await model.stopCast(stopPlayback: true) }
                                }
                                .accessibilityIdentifier("cast.inline.stop")
                            }
                            Button("Remote") { dismiss(); model.showRemote = true }
                                .accessibilityIdentifier("cast.remote")
                        }
                        .padding(.vertical, 4)
                    }
                }

                Section("TVs") {
                    if model.receivers.isEmpty {
                        Text("Looking for PearTube TVs on your Wi-Fi. You can also pair a TV below.")
                            .foregroundStyle(PTColor.dim)
                    }
                    ForEach(model.receivers) { receiver in
                        let status = receiverStatus(receiver)
                        VStack(alignment: .leading, spacing: 8) {
                            Button {
                                if receiver.paired || receiver.openAuth {
                                    Task { await model.selectReceiver(receiver) }
                                } else {
                                    pairTarget = receiver.id
                                }
                            } label: {
                                HStack {
                                    Image(systemName: "tv").font(.title3).foregroundStyle(PTColor.ink)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(receiver.name).font(.headline).foregroundStyle(PTColor.ink)
                                        Text(status.text).font(.caption).foregroundStyle(status.color)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(PTColor.dim)
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(!receiver.current)
                            .accessibilityIdentifier("cast.receiver.\(receiver.id)")

                            HStack {
                                if !receiver.paired && receiver.current {
                                    Button("Enter code") { pairTarget = receiver.id }
                                        .accessibilityIdentifier("cast.code.\(receiver.id)")
                                }
                                if receiver.paired && model.pendingCast != nil && receiver.current {
                                    Button("Play on this TV") { Task { await model.selectReceiver(receiver) } }
                                        .accessibilityIdentifier("cast.play.\(receiver.id)")
                                }
                                Spacer()
                                if receiver.paired {
                                    Button("Forget", role: .destructive) { forgetTarget = receiver }
                                        .accessibilityIdentifier("cast.forget.\(receiver.id)")
                                }
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }

                Section("Pair a TV…") {
                    Picker("TV", selection: $pairTarget) {
                        Text("Choose a nearby TV").tag("")
                        ForEach(model.receivers) { receiver in Text(receiver.name).tag(receiver.id) }
                    }
                    .accessibilityIdentifier("cast.pairTarget")

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Code on the TV").font(.caption).foregroundStyle(PTColor.dim)
                        TextField("K7M2QX", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .focused($codeFocused)
                            .submitLabel(.done)
                            .onSubmit { codeFocused = false }
                            .accessibilityLabel("Code on the TV")
                            .accessibilityIdentifier("cast.pairCode")
                    }

                    Button(pairing ? "Pairing…" : "Pair TV") {
                        pairing = true
                        Task { await model.pairReceiver(id: pairTarget, code: code, address: input); pairing = false }
                    }
                    .disabled((pairTarget.isEmpty && input.isEmpty) || pairing)
                    .accessibilityIdentifier("cast.pair")
                }

                Section("Pair with a link or QR code") {
                    TextField("peartube://receiver/… or 64-character key", text: $input, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("cast.pairInput")
                    Button("Connect TV") {
                        pairing = true
                        Task { await model.pairURI(input); pairing = false }
                    }
                    .disabled(input.isEmpty || pairing)
                    .accessibilityIdentifier("cast.pairURI")
                    Button { scanner = true } label: {
                        Label("Scan TV QR code", systemImage: "qrcode.viewfinder")
                    }
                    .accessibilityIdentifier("cast.scan")
                }
            }
            .navigationTitle("TVs")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Refresh") { Task { await model.refreshCast() } }
                        .accessibilityIdentifier("cast.refresh")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("cast.close")
                }
            }
        }
        .alert(
            "Forget \(forgetTarget?.name ?? "this TV")?",
            isPresented: Binding(get: { forgetTarget != nil }, set: { if !$0 { forgetTarget = nil } })
        ) {
            Button("Forget", role: .destructive) {
                if let target = forgetTarget {
                    Task { await model.forgetReceiver(target.id) }
                }
                forgetTarget = nil
            }
            Button("Cancel", role: .cancel) { forgetTarget = nil }
        } message: {
            Text("Pairing again needs the code shown on the TV.")
        }
        .sheet(isPresented: $scanner) { QRScanner { value in scanner = false; Task { await model.pairURI(value) } } }
        .task { await model.refreshCast() }
    }
}

@MainActor
struct RemoteBar: View {
    @ObservedObject var model: AppModel
    var body: some View {
        VStack(spacing: 0) {
            PTDivider()
            HStack {
                Button { model.showRemote = true } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "tv")
                            .font(.title3)
                            .foregroundStyle(PTColor.ok)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.session.object("state").object("entry").string("title"))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(PTColor.ink)
                                .lineLimit(1)
                            Text("\(model.session.string("receiverName")) · \(clock(model.remoteState.positionMs))")
                                .font(.caption)
                                .foregroundStyle(PTColor.dim)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("cast.remote")

                IconButton(title: model.remoteState.playing ? "Pause on TV" : "Play on TV", icon: model.remoteState.playing ? "pause.fill" : "play.fill", identifier: "remote.bar.pause") {
                    Task { await model.control("togglePlay") }
                }
                .foregroundStyle(PTColor.ink)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(PTColor.raised)
        }
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
                if model.session.isEmpty {
                    Section {
                        Text("No TV is playing right now.")
                        Button("Choose a TV") { dismiss(); model.chooseCast() }
                    }
                } else {
                    Section("Playing on \(model.session.string("receiverName"))") {
                        Text(model.session.object("state").object("entry").string("title")).font(.title3.bold())
                        if !state.error.isEmpty { Text(state.error).foregroundStyle(PTColor.bad).accessibilityIdentifier("remote.error") }
                        Text("\(clock(state.positionMs)) / \(clock(state.durationMs))").font(.body.monospacedDigit()).accessibilityIdentifier("remote.clock")
                        Slider(value: Binding(get: { scrubbing ? scrub : min(state.positionMs, max(1, state.durationMs)) }, set: { scrub = $0 }), in: 0...max(1, state.durationMs)) { editing in
                            scrubbing = editing
                            if editing { scrub = state.positionMs }
                            else { Task { await model.control("seek", ["positionMs": scrub]) } }
                        }
                        .tint(PTColor.brand)
                        .disabled(state.durationMs <= 0)
                        .accessibilityIdentifier("remote.seek")
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
                            Text("This TV does not report track names. Use its stream index or switch subtitles off.").font(.caption).foregroundStyle(PTColor.dim)
                        }
                        Button("Subtitles Off") { Task { await model.control("selectSubtitle", ["stream": -1]) } }.accessibilityIdentifier("remote.subtitles.off")
                    }
                    if state.json["volume"] is NSNumber || state.json["muted"] is NSNumber {
                        Section("Volume") {
                            Slider(value: $volume, in: 0...1) { editing in if !editing { Task { await model.control("volume", ["volume": volume]) } } }
                                .tint(PTColor.brand)
                                .accessibilityIdentifier("remote.volume")
                            Button(state.json.flag("muted") ? "Unmute" : "Mute") { Task { await model.control("volume", ["muted": !state.json.flag("muted")]) } }.accessibilityIdentifier("remote.mute")
                        }
                    }
                    Section("Playback location") {
                        Button("Switch to this iPhone") { Task { await model.transferBack() } }.accessibilityIdentifier("remote.switchLocal")
                        Button("Leave playing on TV") { Task { await model.stopCast(stopPlayback: false) } }.accessibilityIdentifier("remote.detach")
                        Button("Stop", role: .destructive) { Task { await model.stopCast(stopPlayback: true) } }.accessibilityIdentifier("remote.stop")
                    }
                    Section("TV state") {
                        LabeledContent("Peers", value: String(Int(state.json.number("p2pPeers"))))
                        LabeledContent("Cached", value: bytes(state.json.number("cachedBytes")))
                        LabeledContent("Seeding", value: state.json.flag("seeding") ? "Yes" : "No")
                        Text(jsonText(state.json)).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("Remote")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("remote.close") } }
        }
        .onAppear { if state.json["volume"] is NSNumber { volume = state.json.number("volume") } }
        .task { await model.refreshCast() }
    }
}
