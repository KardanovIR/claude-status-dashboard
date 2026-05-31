package com.claudestatus.dashboard

import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.PopupMenu
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.claudestatus.dashboard.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var webView: WebView

    private val setupLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val newUrl = result.data?.getStringExtra(SetupActivity.EXTRA_URL)
            ?: Prefs.dashboardUrl(this)
        applyKeepAwake()
        if (!newUrl.isNullOrBlank()) {
            loadDashboard(newUrl)
        } else {
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        enableImmersive()

        webView = binding.webView
        configureWebView(webView)
        applyKeepAwake()

        binding.swipeRefresh.setOnRefreshListener { webView.reload() }
        binding.retryButton.setOnClickListener {
            val url = Prefs.dashboardUrl(this) ?: return@setOnClickListener
            showError(false, null)
            loadDashboard(url)
        }
        binding.menuButton.setOnClickListener { showOverflowMenu(it) }
        binding.menuButton.setOnLongClickListener {
            launchSetup()
            true
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        val url = Prefs.dashboardUrl(this)
        if (url.isNullOrBlank()) {
            launchSetup()
        } else {
            loadDashboard(url)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableImmersive()
    }

    private fun enableImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, binding.root).apply {
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        webView.loadUrl("about:blank")
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }

    private fun showOverflowMenu(anchor: View) {
        val popup = PopupMenu(this, anchor)
        popup.menuInflater.inflate(R.menu.main_menu, popup.menu)
        popup.menu.findItem(R.id.action_keep_awake)?.isChecked = Prefs.keepAwake(this)
        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_reload -> { webView.reload(); true }
                R.id.action_settings -> { launchSetup(); true }
                R.id.action_keep_awake -> {
                    val newValue = !item.isChecked
                    item.isChecked = newValue
                    Prefs.setKeepAwake(this, newValue)
                    applyKeepAwake()
                    true
                }
                else -> false
            }
        }
        popup.show()
    }

    private fun configureWebView(wv: WebView) {
        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        wv.webChromeClient = WebChromeClient()
        wv.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                binding.swipeRefresh.isRefreshing = true
                showError(false, null)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                binding.swipeRefresh.isRefreshing = false
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val target = request?.url?.toString() ?: return false
                val configured = Prefs.dashboardUrl(this@MainActivity)
                if (configured != null && target.startsWith(configured)) return false
                if (target.startsWith("http://") || target.startsWith("https://")) {
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                        true
                    } catch (_: Exception) {
                        false
                    }
                }
                return false
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame != true) return
                binding.swipeRefresh.isRefreshing = false
                showError(true, error?.description?.toString())
            }
        }
    }

    private fun loadDashboard(url: String) {
        binding.errorView.visibility = View.GONE
        binding.swipeRefresh.visibility = View.VISIBLE
        webView.loadUrl(url)
    }

    private fun launchSetup() {
        setupLauncher.launch(Intent(this, SetupActivity::class.java))
    }

    private fun showError(visible: Boolean, message: String?) {
        binding.errorView.visibility = if (visible) View.VISIBLE else View.GONE
        binding.swipeRefresh.visibility = if (visible) View.GONE else View.VISIBLE
        if (visible) {
            binding.errorMessage.text = message
                ?: getString(R.string.error_generic)
        }
    }

    private fun applyKeepAwake() {
        if (Prefs.keepAwake(this)) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
}
