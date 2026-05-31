import SwiftUI
import WebKit

struct DashboardWebView: UIViewRepresentable {
    let url: URL
    @Binding var reloadToken: Int
    @Binding var isLoading: Bool
    @Binding var loadError: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.allowsInlineMediaPlayback = true

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = context.coordinator
        wv.scrollView.bounces = true
        wv.scrollView.alwaysBounceVertical = true
        wv.isOpaque = false
        wv.backgroundColor = UIColor(red: 0x0b/255, green: 0x0d/255, blue: 0x12/255, alpha: 1)
        wv.scrollView.backgroundColor = wv.backgroundColor

        let refresh = UIRefreshControl()
        refresh.tintColor = .lightGray
        refresh.addTarget(context.coordinator,
                          action: #selector(Coordinator.handleRefresh(_:)),
                          for: .valueChanged)
        wv.scrollView.refreshControl = refresh
        context.coordinator.webView = wv

        wv.load(URLRequest(url: url))
        return wv
    }

    func updateUIView(_ wv: WKWebView, context: Context) {
        let coord = context.coordinator
        if coord.lastURL != url {
            coord.lastURL = url
            wv.load(URLRequest(url: url))
        }
        if coord.lastReloadToken != reloadToken {
            coord.lastReloadToken = reloadToken
            wv.reload()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: DashboardWebView
        weak var webView: WKWebView?
        var lastURL: URL?
        var lastReloadToken: Int = 0

        init(_ parent: DashboardWebView) {
            self.parent = parent
            self.lastURL = parent.url
            self.lastReloadToken = parent.reloadToken
        }

        @objc func handleRefresh(_ sender: UIRefreshControl) {
            webView?.reload()
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            parent.isLoading = true
            parent.loadError = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.isLoading = false
            webView.scrollView.refreshControl?.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.isLoading = false
            parent.loadError = error.localizedDescription
            webView.scrollView.refreshControl?.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            parent.isLoading = false
            parent.loadError = error.localizedDescription
            webView.scrollView.refreshControl?.endRefreshing()
        }

        // Route off-dashboard links out to Safari.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = navigationAction.request.url else {
                decisionHandler(.allow); return
            }
            if let host = target.host, let base = parent.url.host, host == base {
                decisionHandler(.allow); return
            }
            if navigationAction.navigationType == .linkActivated,
               (target.scheme == "http" || target.scheme == "https") {
                UIApplication.shared.open(target)
                decisionHandler(.cancel); return
            }
            decisionHandler(.allow)
        }
    }
}
