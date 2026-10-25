package app.forerunner.mobile

import android.content.Context

/**
 * The current FCM registration token, in the app's private preferences (ADR 0085 point 9).
 * Written by `ForerunnerMessagingService.onNewToken` and by `FcmStartup` at every launch
 * (`FirebaseMessaging.getInstance().token`); read by `KeystorePlugin.info`, which the Rust
 * shell asks on every `push_status`. The token is not a key: it only addresses this install
 * and the state service already holds it. It is never logged. Builds without
 * `google-services.json` never write it, and `info` reports null.
 */
object PushTokenStore {
  private const val PREFS = "forerunner.push"
  private const val KEY_TOKEN = "fcmToken"
  private const val KEY_ASKED = "notificationPermissionAsked"

  fun save(context: Context, token: String?) {
    val value = token?.trim().orEmpty()
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
    if (value.isEmpty()) prefs.remove(KEY_TOKEN) else prefs.putString(KEY_TOKEN, value)
    prefs.apply()
  }

  fun read(context: Context): String? =
    context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(KEY_TOKEN, null)
      ?.takeIf { it.isNotBlank() }

  /** Android 13+ asks for POST_NOTIFICATIONS once per install; later the human uses Settings. */
  fun markPermissionAsked(context: Context): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (prefs.getBoolean(KEY_ASKED, false)) return false
    prefs.edit().putBoolean(KEY_ASKED, true).apply()
    return true
  }
}
