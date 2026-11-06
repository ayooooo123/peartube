import SwiftUI
import UIKit

@main
struct PearTubeApp: App {
    @UIApplicationDelegateAdaptor(PearTubeDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .preferredColorScheme(.dark)
                .tint(.mint)
                .onOpenURL { url in Task { await model.openURI(url.absoluteString) } }
                .onChange(of: scenePhase) { _, phase in model.sceneChanged(phase) }
        }
    }
}

final class PearTubeDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask { .allButUpsideDown }
}

@MainActor
struct RootView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var player: NativePlayer
    init(model: AppModel) { self.model = model; player = model.player }
    var body: some View {
        ZStack {
            Color(red: 0.035, green: 0.045, blue: 0.065).ignoresSafeArea()
            if player.entry != nil { PlayerScreen(model: model, player: player) }
            else { LibraryScreen(model: model) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !model.session.isEmpty && player.entry == nil { RemoteBar(model: model) }
        }
        .sheet(isPresented: $model.showSettings) { SettingsScreen(model: model) }
        .sheet(isPresented: $model.showDiagnostics) { DiagnosticsScreen(model: model) }
        .sheet(isPresented: $model.showCast, onDismiss: { model.pendingCast = nil }) { CastScreen(model: model) }
        .sheet(isPresented: $model.showRemote) { RemoteScreen(model: model) }
        .sheet(isPresented: $model.showScanner) {
            QRScanner { value in
                model.showScanner = false
                Task {
                    if value.lowercased().hasPrefix("peartube:") || (value.count == 64 && value.allSatisfy(\.isHexDigit)) { await model.openURI(value) }
                    else { await model.pairURI(value) }
                }
            }
        }
        .sheet(isPresented: Binding(get: { model.shareURI != nil }, set: { if !$0 { model.shareURI = nil } })) {
            if let uri = model.shareURI { ShareQR(uri: uri) }
        }
        .alert("PearTube", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .overlay(alignment: .top) {
            if let notice = model.notice {
                Text(notice).font(.callout).padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    .padding().onTapGesture { model.notice = nil }
                    .task(id: notice) { try? await Task.sleep(for: .seconds(5)); if model.notice == notice { model.notice = nil } }
            }
        }
    }
}

struct IconButton: View {
    let title: String
    let icon: String
    let identifier: String
    let action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: icon).font(.title3).frame(minWidth: 44, minHeight: 44) }
            .accessibilityLabel(title).accessibilityIdentifier(identifier)
    }
}
