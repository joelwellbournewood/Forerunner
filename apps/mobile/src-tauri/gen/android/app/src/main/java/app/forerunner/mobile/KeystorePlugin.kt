package app.forerunner.mobile

import android.app.Activity
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class WrapArgs {
  var data: String = ""
}

/**
 * The Android Keystore side of the shell's secure store (spec R.7, ADR 0009, ADR 0032).
 *
 * The Rust shell (`src/keystore.rs`) keeps the Ed25519 device seed and the state service's
 * session token in the app's private files, wrapped by this plugin: one AES-256-GCM key,
 * generated inside the Android Keystore (StrongBox when the phone has one, the TEE
 * otherwise), never exportable, used only to `wrap` and `unwrap` those bytes. A wrapped
 * value is `IV (12 bytes) || ciphertext || GCM tag`. Nothing here logs plaintext, the
 * wrapped bytes or key material; errors name only what failed.
 *
 * `info` reports the device model (suggested device name at pairing), whether StrongBox
 * exists, whether a biometric prompt can be shown and, once a Firebase project is wired,
 * the FCM registration token (absent in this build; see `docs/status/BLOCKERS.md`).
 */
@TauriPlugin
class KeystorePlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private const val ALIAS = "forerunner.device-store"
    private const val PROVIDER = "AndroidKeyStore"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_LEN = 12
    private const val TAG_BITS = 128
  }

  private fun hasStrongBox(): Boolean =
    activity.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

  private fun spec(strongBox: Boolean): KeyGenParameterSpec {
    val builder =
      KeyGenParameterSpec.Builder(
          ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
    if (strongBox) builder.setIsStrongBoxBacked(true)
    return builder.build()
  }

  /** The wrapping key, generated on first use; it never leaves the Keystore. */
  @Synchronized
  private fun key(): SecretKey {
    val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let {
      return it
    }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
    if (hasStrongBox()) {
      try {
        generator.init(spec(true))
        return generator.generateKey()
      } catch (_: StrongBoxUnavailableException) {
        // The phone advertises StrongBox but cannot host this key: use the TEE.
      }
    }
    generator.init(spec(false))
    return generator.generateKey()
  }

  @Command
  fun wrap(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(WrapArgs::class.java)
      val plain = Base64.decode(args.data, Base64.DEFAULT)
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val iv = cipher.iv
      if (iv.size != IV_LEN) throw IllegalStateException("unexpected GCM nonce length")
      val sealed = cipher.doFinal(plain)
      val out = JSObject()
      out.put("data", Base64.encodeToString(iv + sealed, Base64.NO_WRAP))
      invoke.resolve(out)
    } catch (e: Exception) {
      invoke.reject("keystore wrap failed: " + e.javaClass.simpleName)
    }
  }

  @Command
  fun unwrap(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(WrapArgs::class.java)
      val wrapped = Base64.decode(args.data, Base64.DEFAULT)
      if (wrapped.size < IV_LEN + TAG_BITS / 8) throw IllegalArgumentException("wrapped value too short")
      val iv = wrapped.copyOfRange(0, IV_LEN)
      val sealed = wrapped.copyOfRange(IV_LEN, wrapped.size)
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
      val plain = cipher.doFinal(sealed)
      val out = JSObject()
      out.put("data", Base64.encodeToString(plain, Base64.NO_WRAP))
      invoke.resolve(out)
    } catch (e: Exception) {
      invoke.reject("keystore unwrap failed: " + e.javaClass.simpleName)
    }
  }

  @Command
  fun info(invoke: Invoke) {
    val out = JSObject()
    out.put("model", (Build.MANUFACTURER + " " + Build.MODEL).trim())
    out.put("strongBox", hasStrongBox())
    out.put("biometric", biometricAvailable())
    // FCM: no Firebase project in this build; when one exists, put the token from
    // FirebaseMessaging.getInstance().token here as "fcmToken" (ADR 0032).
    invoke.resolve(out)
  }

  private fun biometricAvailable(): Boolean {
    val manager = activity.getSystemService(BiometricManager::class.java) ?: return false
    val result =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      } else {
        @Suppress("DEPRECATION") manager.canAuthenticate()
      }
    return result == BiometricManager.BIOMETRIC_SUCCESS
  }
}
