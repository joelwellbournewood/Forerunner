package app.forerunner.mobile

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM's entry point (ADR 0085 points 8 and 9). Compiled only when `google-services.json` is
 * in the app module (or with `-PforerunnerFcmCompileCheck=true`); see `app/build.gradle.kts`.
 *
 * - `onNewToken`: the new registration token goes to `PushTokenStore`; the UI finds it through
 *   `push_status` on the next foreground and sends it with `PUT /devices/:id/push-token`.
 * - `onMessageReceived`: runs for a message that arrives while the app is in the foreground
 *   (in the background the system tray shows the notification block itself, on the default
 *   channel from the manifest). It posts the same generic title and body with a tap that
 *   opens `link` in the app. The four kinds are approval, session, budget and message; any
 *   other kind, or a link that is not a plain app path, is dropped.
 *
 * Nothing here logs the token or the message.
 */
class ForerunnerMessagingService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    PushTokenStore.save(applicationContext, token)
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    val kind = data[PushLinks.EXTRA_KIND]
    if (!PushLinks.isKnownKind(kind)) return
    val link = PushLinks.safeLink(data[PushLinks.EXTRA_LINK]) ?: return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (!manager.areNotificationsEnabled()) return
    FcmStartup.ensureChannels(this)

    val open =
      Intent(this, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(PushLinks.EXTRA_KIND, kind)
        .putExtra(PushLinks.EXTRA_ID, data[PushLinks.EXTRA_ID])
        .putExtra(PushLinks.EXTRA_LINK, link)
    val id = PushLinks.notificationId(kind, data[PushLinks.EXTRA_ID])
    val tap =
      PendingIntent.getActivity(
        this,
        id,
        open,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    val notification =
      Notification.Builder(this, PushLinks.channelFor(kind))
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(message.notification?.title ?: PushLinks.defaultTitle(kind))
        .setContentText(message.notification?.body.orEmpty())
        .setContentIntent(tap)
        .setAutoCancel(true)
        .build()
    manager.notify(id, notification)
  }
}
