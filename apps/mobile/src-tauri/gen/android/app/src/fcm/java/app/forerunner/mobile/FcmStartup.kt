package app.forerunner.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Runs once per process start, before any activity (declared in `src/fcm/AndroidManifest.xml`
 * after Firebase's own init provider): creates the two notification channels and asks
 * Firebase for the current registration token, which goes to `PushTokenStore`. `onNewToken`
 * covers rotations while the process lives; this covers a token that already existed (an app
 * update, a restored backup with a stale value). In a build without a Firebase configuration
 * (`-PforerunnerFcmCompileCheck=true` alone) there is no FirebaseApp and nothing happens.
 */
class FcmStartup : ContentProvider() {
  override fun onCreate(): Boolean {
    val context = context ?: return false
    ensureChannels(context)
    try {
      FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
        PushTokenStore.save(context, token)
      }
    } catch (_: IllegalStateException) {
      // No FirebaseApp (no google-services.json values): the polling stand-in stays.
    }
    return true
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  companion object {
    /** Idempotent: Android keeps an existing channel and the human's settings for it. */
    fun ensureChannels(context: Context) {
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      manager.createNotificationChannel(
        NotificationChannel(
          PushLinks.CHANNEL_ATTENTION,
          context.getString(R.string.push_channel_attention),
          NotificationManager.IMPORTANCE_HIGH,
        )
      )
      manager.createNotificationChannel(
        NotificationChannel(
          PushLinks.CHANNEL_UPDATES,
          context.getString(R.string.push_channel_updates),
          NotificationManager.IMPORTANCE_DEFAULT,
        )
      )
    }
  }
}
