package app.forerunner.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // A tap on a push notification launches this activity with the FCM data as extras (the
    // system tray's notification while the app is in the background, ours while it is in the
    // foreground). It becomes `fr://open?link=...` before the deep-link plugin reads the
    // intent in its `load`, so the UI opens the route like any other link (ADR 0085 point 8).
    pushLinkIntent(intent)?.let { intent = it }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (BuildConfig.FCM_CONFIGURED) askForNotificationPermission()
  }

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
