import SwiftUI
import UIKit

struct MediaGroup: Identifiable {
    let id: String
    let entries: [MediaEntry]
}

@MainActor
struct LibraryScreen: View {
    @ObservedObject var model: AppModel
    @State private var info: MediaEntry?
    private var groups: [MediaGroup] {
        Dictionary(grouping: model.visibleEntries, by: \.groupKey).map { MediaGroup(id: $0.key, entries: $0.value) }
            .sorted { ($0.entries.first?.title ?? "").localizedStandardCompare($1.entries.first?.title ?? "") == .orderedAscending }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.showDiagnostics = true } label: {
                    HStack(spacing: 8) {
                        Text("PearTube").font(.title2.bold())
                        Circle().fill(model.status.number("peers") + model.status.number("lanPeers") > 0 ? Color.mint : .secondary).frame(width: 7, height: 7)
                    }
                }.buttonStyle(.plain).accessibilityIdentifier("library.hood")
                Spacer()
                IconButton(title: "Cast", icon: model.session.isEmpty ? "airplayvideo" : "airplayvideo.badge.exclamationmark", identifier: "library.cast") { model.chooseCast() }
                IconButton(title: "Settings", icon: "gearshape", identifier: "library.settings") { model.showSettings = true }
            }.padding(.horizontal)
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Title, ID, key or PearTube URI", text: $model.query)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(model.contextualQuery ? .go : .search)
                    .accessibilityIdentifier("search.field")
                    .onSubmit { if model.contextualQuery { Task { await model.openURI(model.query) } } }
                if !model.query.isEmpty { IconButton(title: "Clear search", icon: "xmark.circle.fill", identifier: "search.clear") { model.query = "" } }
                IconButton(title: "Scan QR code", icon: "qrcode.viewfinder", identifier: "search.scan") { model.showScanner = true }
            }.padding(.leading, 14).background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 22)).padding(.horizontal).padding(.vertical, 8)
            if model.contextualQuery {
                Button { Task { await model.openURI(model.query) } } label: {
                    HStack { Label(model.smartAction, systemImage: "link"); Spacer(); Image(systemName: "arrow.right.circle.fill") }.padding()
                }.background(.mint.opacity(0.1), in: RoundedRectangle(cornerRadius: 14)).padding(.horizontal).accessibilityIdentifier("search.open")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    filter("All", "all"); filter("Movies", "movies"); filter("Series", "series"); filter("On Device", "device")
                    ForEach(model.sources, id: \.selfKey) { source in
                        let key = source.string("key")
                        Button { model.sourceFilter = model.sourceFilter == key ? "" : key } label: {
                            Text(SourceSpec(source).name).padding(.horizontal, 12).padding(.vertical, 9)
                                .background(model.sourceFilter == key ? Color.mint.opacity(0.25) : .white.opacity(0.06), in: Capsule())
                        }.accessibilityIdentifier("filters.source.\(key)")
                    }
                }.padding(.horizontal).padding(.vertical, 8)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.query.isEmpty && model.filter == "All" && model.sourceFilter.isEmpty && !model.continueEntries.isEmpty {
                        Text("Continue Watching").font(.headline)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(model.continueEntries.prefix(10)) { entry in
                                    Button { model.play(entry) } label: {
                                        VStack(alignment: .leading, spacing: 6) {
                                            Label(entry.episode ?? "Movie", systemImage: "play.circle.fill").foregroundStyle(.mint)
                                            Text(entry.title).lineLimit(2)
                                            Text("Resume at \(clock(model.history[entry.key]?.positionMs ?? 0))").font(.caption).foregroundStyle(.secondary)
                                        }.frame(width: 230, alignment: .leading).padding().background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
                                    }.buttonStyle(.plain).accessibilityIdentifier("library.continue.\(entry.key)")
                                }
                            }
                        }
                    }
                    if groups.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            if model.busy { ProgressView("Connecting to your sources…") }
                            Text(model.entries.isEmpty ? "Your next cinema moment awaits." : "Nothing matches this search.").font(.title3.bold())
                            Text(model.settings.hasSources ? "Your subscribed peers will share their catalog when they connect. You can change sources or network settings at any time." : "Add a tracker, follow a channel, or open a PearTube link. You can explore settings without adding a source.").foregroundStyle(.secondary)
                            Button("Add Channel or Link") { model.showSettings = true }.accessibilityIdentifier("library.addSource")
                        }.padding(.vertical, 36)
                    }
                    ForEach(groups) { group in
                        if group.entries.first?.episode != nil { SeriesCard(model: model, entries: group.entries, onInfo: { info = $0 }) }
                        else if let entry = group.entries.first { EntryCard(model: model, entry: entry, formats: group.entries, onInfo: { info = entry }) }
                    }
                }.padding()
            }.refreshable { await model.refresh() }
        }
        .sheet(item: $info) { entry in EntryInfoScreen(model: model, entry: entry) }
    }
    private func filter(_ name: String, _ id: String) -> some View {
        Button { model.filter = name } label: {
            Text(name).font(.subheadline.weight(.medium)).padding(.horizontal, 14).padding(.vertical, 9)
                .background(model.filter == name ? Color.mint.opacity(0.25) : .white.opacity(0.06), in: Capsule())
        }.accessibilityIdentifier("filters.\(id)").accessibilityAddTraits(model.filter == name ? .isSelected : [])
    }
}

extension Dictionary where Key == String, Value == Any {
    var selfKey: String { string("key") }
}

@MainActor
struct EntryCard: View {
    @ObservedObject var model: AppModel
    let entry: MediaEntry
    let formats: [MediaEntry]
    var onInfo: () -> Void
    var body: some View {
        let dl = model.downloads[entry.key]
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Button { model.play(entry) } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(entry.title).font(.headline).foregroundStyle(.primary).multilineTextAlignment(.leading)
                        if let dl {
                            let pct = entry.size > 0 ? Int(min(100, (dl * 100) / max(1, entry.size))) : 0
                            Text("\(entry.episode ?? "Movie") · \(bytes(entry.size)) · Downloading \(entry.size > 0 ? "\(pct)%" : bytes(dl))").font(.caption).foregroundStyle(.cyan)
                        } else {
                            let lockLabel = entry.locked ? " · Subscriber pass needed" : (entry.isPrivate ? " · Subscribers only" : "")
                            Text("\(entry.episode ?? "Movie") · \(bytes(entry.size))\(entry.saved ? " · Saved" : "")\(lockLabel)").font(.caption).foregroundStyle(entry.locked ? .red : .secondary)
                        }
                        if let progress = model.history[entry.key], progress.partial { Text("Resume \(clock(progress.positionMs))").font(.caption).foregroundStyle(.mint) }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding()
                }.buttonStyle(.plain).accessibilityIdentifier("library.entry.\(entry.key)")
                if !entry.locked {
                    IconButton(title: "Cast \(entry.title)", icon: "airplayvideo", identifier: "library.cast.\(entry.key)") { model.chooseCast(entry) }
                    if dl != nil {
                        IconButton(title: "Cancel download \(entry.title)", icon: "xmark.circle", identifier: "library.download.\(entry.key)") { model.cancelDownload(entry.key) }
                    } else {
                        IconButton(title: "Download \(entry.title)", icon: "arrow.down.circle", identifier: "library.download.\(entry.key)") { model.download(entry) }
                    }
                }
                Menu {
                    Button("Media Info", systemImage: "info.circle", action: onInfo)
                    if formats.count > 1 && !entry.locked {
                        Menu("Formats") {
                            ForEach(formats) { format in Button("\(format.title) · \(bytes(format.size))") { model.play(format) } }
                        }
                    }
                    if !entry.locked {
                        Button("Cast to TV", systemImage: "airplayvideo") { model.chooseCast(entry) }
                        if dl != nil {
                            Button("Cancel Download", systemImage: "xmark.circle", role: .destructive) { model.cancelDownload(entry.key) }
                        } else {
                            Button("Download Video", systemImage: "arrow.down.circle") { model.download(entry) }
                        }
                    }
                    if !entry.magnetURL.isEmpty { ShareLink("Share Link", item: entry.magnetURL); Button("Show Sharing QR") { model.shareURI = entry.magnetURL } }
                    if !entry.local && entry.cachedBytes > 0 { Button("Free Up Cache", role: .destructive) { Task { await model.clearCache(entry.key) } } }
                    if model.status.flag("writable") && !model.status.string("channel").isEmpty && model.status.string("channel") == entry.source {
                        Button("Delete from Channel", systemImage: "trash", role: .destructive) { Task { await model.removeChannelEntry(entry.key) } }
                    }
                } label: { Image(systemName: "ellipsis").frame(width: 36, height: 44) }.accessibilityIdentifier("library.more.\(entry.key)")
            }
            if let dl, entry.size > 0 {
                ProgressView(value: min(1, max(0.02, dl / entry.size))).tint(.cyan)
            } else if let progress = model.history[entry.key], progress.partial && progress.durationMs > 0 {
                ProgressView(value: min(1, progress.positionMs / progress.durationMs)).tint(.mint)
            } else if !entry.local && entry.size > 0 && entry.cachedBytes > 0 {
                ProgressView(value: min(1, entry.cachedBytes / entry.size)).tint(.cyan)
            }
        }.background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 18)).clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

@MainActor
struct SeriesCard: View {
    @ObservedObject var model: AppModel
    let entries: [MediaEntry]
    let onInfo: (MediaEntry) -> Void
    @State private var expanded = false
    @State private var selectedSeason = ""
    private var episodes: [MediaEntry] {
        Dictionary(grouping: entries, by: \.mediaID).values.compactMap { $0.first }.sorted { $0.episodeOrder < $1.episodeOrder }
    }
    private var seasons: [String] { Array(Set(episodes.map(\.season))).sorted() }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { expanded.toggle() } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(entries.first?.seriesTitle ?? "Series").font(.headline)
                        Text("\(episodes.count) episodes · \(seasons.count) seasons").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(); Image(systemName: expanded ? "chevron.down" : "chevron.right")
                }.padding(.horizontal).padding(.top)
            }.buttonStyle(.plain).accessibilityIdentifier("library.series.\(entries.first?.groupKey ?? "")")
            if let next = model.seriesNext(episodes) {
                Button { model.play(next) } label: { Label("\(model.history[next.key]?.partial == true ? "Resume" : "Play") \(next.episode ?? "")", systemImage: "play.fill") }
                    .padding(.horizontal).accessibilityIdentifier("library.seriesResume.\(next.groupKey)")
            }
            if expanded || (!model.query.isEmpty && !model.contextualQuery) || episodes.count <= 2 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(seasons, id: \.self) { season in
                            Button(season) { selectedSeason = season }
                                .buttonStyle(.bordered).tint((selectedSeason.isEmpty ? seasons.first : selectedSeason) == season ? .mint : .gray)
                                .accessibilityIdentifier("library.season.\(entries.first?.groupKey ?? "").\(season)")
                        }
                    }.padding(.horizontal)
                }
                ForEach(episodes.filter { $0.season == (selectedSeason.isEmpty ? seasons.first ?? "" : selectedSeason) }) { episode in
                    EntryCard(model: model, entry: episode, formats: entries.filter { $0.mediaID == episode.mediaID }, onInfo: { onInfo(episode) })
                }
            }
        }.padding(.bottom, 14).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 18))
    }
}

@MainActor
struct EntryInfoScreen: View {
    @ObservedObject var model: AppModel
    let entry: MediaEntry
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("Media") {
                    Text(entry.title).font(.headline)
                    LabeledContent("ID", value: entry.mediaID)
                    LabeledContent("Size", value: bytes(entry.size))
                    LabeledContent("On Device", value: entry.saved ? "Saved" : bytes(entry.cachedBytes))
                    Text(entry.sha256).font(.caption.monospaced()).textSelection(.enabled)
                    if !entry.magnetURL.isEmpty { ShareLink("Share Stream", item: entry.magnetURL) }
                }
                Section("Format Alternatives") {
                    ForEach(model.entries.filter { $0.mediaID == entry.mediaID }) { format in
                        Button { dismiss(); model.play(format) } label: { VStack(alignment: .leading) { Text(format.title); Text(bytes(format.size)).font(.caption).foregroundStyle(.secondary) } }
                            .accessibilityIdentifier("media.format.\(format.key)")
                    }
                }
            }.navigationTitle("Media Info").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
