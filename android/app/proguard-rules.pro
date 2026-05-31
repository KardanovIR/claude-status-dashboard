# Keep WebView JavaScript interfaces if added later.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
