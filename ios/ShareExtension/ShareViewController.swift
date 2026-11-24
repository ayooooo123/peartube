import UIKit
import UniformTypeIdentifiers

@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private var didStartHandling = false

    private let statusLabel: UILabel = {
        let label = UILabel()
        label.text = "Opening in PearTube…"
        label.font = .preferredFont(forTextStyle: .callout)
        label.textColor = UIColor(red: 0.95, green: 0.96, blue: 0.97, alpha: 1)
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.03, green: 0.035, blue: 0.05, alpha: 0.96)
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.color = UIColor(red: 0.57, green: 0.28, blue: 1.0, alpha: 1)
        spinner.startAnimating()
        spinner.translatesAutoresizingMaskIntoConstraints = false

        let stack = UIStackView(arrangedSubviews: [spinner, statusLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !didStartHandling else { return }
        didStartHandling = true
        Task { await handleSharedItems() }
    }

    @MainActor
    private func handleSharedItems() async {
        let extracted = await extractFromExtensionContext()
        guard let target = extracted, let deepLink = makeDeepLink(for: target) else {
            complete()
            return
        }
        openHostApp(url: deepLink)
    }

    private func extractFromExtensionContext() async -> String? {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else { return nil }

        // Prefer explicit URL attachments first, then plain text attachments, then item text.
        for item in items {
            let providers = item.attachments ?? []
            for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                if let text = await loadText(from: provider, typeIdentifier: UTType.url.identifier),
                   let found = extractURL(from: text) {
                    return found
                }
            }
        }
        for item in items {
            let providers = item.attachments ?? []
            for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                if let text = await loadText(from: provider, typeIdentifier: UTType.plainText.identifier),
                   let found = extractURL(from: text) {
                    return found
                }
            }
        }
        for item in items {
            if let text = item.attributedContentText?.string, let found = extractURL(from: text) {
                return found
            }
            if let text = item.attributedTitle?.string, let found = extractURL(from: text) {
                return found
            }
        }
        return nil
    }

    private func loadText(from provider: NSItemProvider, typeIdentifier: String) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url.absoluteString)
                } else if let nsurl = item as? NSURL, let str = nsurl.absoluteString {
                    continuation.resume(returning: str)
                } else if let str = item as? String {
                    continuation.resume(returning: str)
                } else if let nsstr = item as? NSString {
                    continuation.resume(returning: nsstr as String)
                } else if let data = item as? Data, let str = String(data: data, encoding: .utf8) {
                    continuation.resume(returning: str)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    @MainActor
    private func openHostApp(url: URL) {
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication {
                application.open(url, options: [:]) { [weak self] _ in
                    Task { @MainActor in self?.complete() }
                }
                return
            }
            responder = current.next
        }
        extensionContext?.open(url) { [weak self] _ in
            Task { @MainActor in self?.complete() }
        }
    }

    @MainActor
    private func complete() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    private func makeDeepLink(for target: String) -> URL? {
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#?"))
        guard let encoded = target.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "peartube://add?url=\(encoded)")
    }

    private func extractURL(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let range = trimmed.range(of: "peartube://[^\\s]+", options: [.regularExpression, .caseInsensitive]) {
            let candidate = stripTrailingPunctuation(String(trimmed[range]))
            if candidate.lowercased().hasPrefix("peartube://add"),
               let components = URLComponents(string: candidate),
               let nested = components.queryItems?.first(where: { $0.name == "url" })?.value,
               !nested.isEmpty {
                return extractURL(from: nested) ?? nested
            }
            return candidate
        }
        if let range = trimmed.range(of: "https?://[^\\s<>\"'\\u{200B}-\\u{200D}\\u{FEFF}]+", options: [.regularExpression, .caseInsensitive]) {
            let candidate = stripTrailingPunctuation(String(trimmed[range]))
            if let url = URL(string: candidate), let host = url.host, !host.isEmpty {
                return candidate
            }
        }
        if trimmed.count == 64 && trimmed.allSatisfy(\.isHexDigit) {
            return trimmed.lowercased()
        }
        return nil
    }

    private func stripTrailingPunctuation(_ raw: String) -> String {
        var result = raw
        let trimChars: Set<Character> = [".", ",", ";", ":", "!", "?", "\"", "'", ">", "»", "”", "’"]
        while let last = result.last {
            if trimChars.contains(last) {
                result.removeLast()
            } else if last == ")", result.filter({ $0 == ")" }).count > result.filter({ $0 == "(" }).count {
                result.removeLast()
            } else if last == "]", result.filter({ $0 == "]" }).count > result.filter({ $0 == "[" }).count {
                result.removeLast()
            } else {
                break
            }
        }
        return result
    }
}
