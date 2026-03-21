import SwiftUI

struct ContentView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge
  @State private var searchTask: Task<Void, Never>?

  var body: some View {
    NavigationSplitView {
      SidebarView()
        .navigationSplitViewColumnWidth(min: 220, ideal: 250, max: 280)
    } content: {
      FeedListView()
        .navigationSplitViewColumnWidth(min: 340, ideal: 420, max: 520)
    } detail: {
      VideoDetailView()
    }
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(alignment: .leading, spacing: 2) {
          Text("PearTube Native Desktop")
            .font(.headline)
          Text(appState.isSearchActive ? "Global search over the shared Bare host" : hostBridge.statusTitle)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .searchable(
      text: searchText,
      placement: .toolbar,
      prompt: "Search all videos"
    )
    .onDisappear {
      searchTask?.cancel()
    }
  }

  private var searchText: Binding<String> {
    Binding(
      get: { appState.searchQuery },
      set: { newValue in
        searchTask?.cancel()

        let trimmedValue = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedValue.isEmpty else {
          appState.clearSearch()
          return
        }

        appState.beginSearch(query: newValue)
        searchTask = Task {
          try? await Task.sleep(for: .milliseconds(250))
          guard !Task.isCancelled else { return }
          await hostBridge.searchVideos(query: newValue, into: appState)
        }
      }
    )
  }
}

extension Color {
  init(hex: String) {
    let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var int: UInt64 = 0
    Scanner(string: hex).scanHexInt64(&int)

    let red, green, blue: UInt64
    switch hex.count {
    case 6:
      (red, green, blue) = (int >> 16, int >> 8 & 0xff, int & 0xff)
    default:
      (red, green, blue) = (255, 255, 255)
    }

    self.init(
      .sRGB,
      red: Double(red) / 255,
      green: Double(green) / 255,
      blue: Double(blue) / 255,
      opacity: 1
    )
  }
}
