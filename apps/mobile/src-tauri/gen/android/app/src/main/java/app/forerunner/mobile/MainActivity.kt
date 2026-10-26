package app.forerunner.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // A tap on a push notification launches this activity with the FCM data as extras (the
    // system tray's notification while the app is in the background, ours while it is in the
    // foreground). It becomes `fr://open?link=...` before the deep-link plugin reads the
    // intent in its `load`, so the UI opens the route like any other link (ADR 0085 point 8).
    pushLinkIntent(intent)?.let { intent = it }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    padContentForInsets()
    if (BuildConfig.FCM_CONFIGURED) askForNotificationPermission()
  }

  /**
   * Android 15+ lays every app targeting SDK 35+ out edge to edge, and the WebView started at
   * y = 0: the header ran under the clock and the sync badge under the battery icon (R.1, the
   * rc.3 APK on a Samsung SM-S911B). The activity's content view, the WebView's parent, is
   * padded by the system bars, the display cutout and the keyboard (SafeArea.padding), and the
   * insets are consumed so a WebView that reports env(safe-area-inset-*) sees zero and the page
   * never pads them a second time. The padded strips show the theme's window background.
   */
  private fun padContentForInsets() {
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val padding =
        SafeArea.padding(
          insets.edges(WindowInsetsCompat.Type.systemBars()),
          insets.edges(WindowInsetsCompat.Type.displayCutout()),
          insets.edges(WindowInsetsCompat.Type.ime()),
        )
      view.setPadding(padding.left, padding.top, padding.right, padding.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }

  private fun WindowInsetsCompat.edges(type: Int): Edges =
    getInsets(type).let { Edges(it.left, it.top, it.right, it.bottom) }

  override fun onNewIntent(intent: Intent) {
    val next = pushLinkIntent(intent) ?: intent
    setIntent(next)
    super.onNewIntent(next)
  }

  /** The notification tap as a VIEW intent on `fr://open?link=`; null for any other intent. */
  private fun pushLinkIntent(source: Intent?): Intent? {
    if (source == null || source.action == Intent.ACTION_VIEW) return null
    val deepLink = PushLinks.deepLink(source.getStringExtra(PushLinks.EXTRA_LINK)) ?: return null
    return Intent(source).apply {
      action = Intent.ACTION_VIEW
      data = Uri.parse(deepLink)
      removeExtra(PushLinks.EXTRA_LINK)
    }
  }

  /** Android 13+ shows notifications only with POST_NOTIFICATIONS; asked once per install. */
  private fun askForNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    if (!PushTokenStore.markPermissionAsked(this)) return
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
  }

  private companion object {
    const val REQUEST_NOTIFICATIONS = 4101
  }
}
