package app.forerunner.mobile

import java.net.URLEncoder

/**
 * The pure rules of the FCM half (ADR 0085 point 8), kept free of Android and Firebase
 * classes so the JVM unit tests (`src/test`) cover them in every build, with or without
 * `google-services.json`.
 *
 * The state service sends data-minimal messages: a generic title and body and
 * `data { kind, id, link, projectId? }`. A tap opens `link` inside the app: MainActivity
 * turns the notification's intent into `fr://open?link=<path>`, which the deep-link plugin
 * hands to the UI like a pairing link (`apps/ui/src/mobile/push.ts`, `parsePushLink`).
 * Only a plain absolute app path is ever opened.
 */
object PushLinks {
  /** The data key (and intent extra) that carries the in-app route. */
  const val EXTRA_LINK = "link"
  const val EXTRA_KIND = "kind"
  const val EXTRA_ID = "id"

  /** The four kinds the state service sends (`services/state-api/src/push/fanout.ts`). */
  val KINDS = setOf("approval", "session", "budget", "message")

  /** Channel for approvals and budget stops: heads-up. */
  const val CHANNEL_ATTENTION = "attention"
  /** Channel for finished sessions and messages; also FCM's default channel (manifest). */
  const val CHANNEL_UPDATES = "updates"

  private const val OPEN_PREFIX = "fr://open?link="
  private val APP_PATH = Regex("^/[A-Za-z0-9._~/-]{0,199}$")

  /** `link` when it is a plain in-app path (`/inbox`, `/sessions/ses_1`), else null. */
  fun safeLink(link: String?): String? {
    if (link == null || !APP_PATH.matches(link) || link.startsWith("//")) return null
    if (link.split('/').any { it == "." || it == ".." }) return null
    return link
  }

  /** The deep link the UI opens for `link`, or null when `link` is not a safe app path. */
  fun deepLink(link: String?): String? =
    safeLink(link)?.let { OPEN_PREFIX + URLEncoder.encode(it, "UTF-8") }

  fun isKnownKind(kind: String?): Boolean = kind != null && kind in KINDS

  fun channelFor(kind: String?): String =
    when (kind) {
      "approval", "budget" -> CHANNEL_ATTENTION
      else -> CHANNEL_UPDATES
    }

  /** The generic title when a message arrives without its notification block. */
  fun defaultTitle(kind: String?): String =
    when (kind) {
      "approval" -> "Approval needed"
      "session" -> "Session finished"
      "budget" -> "Budget warning"
      else -> "New message"
    }

  /** One notification per item: a second push for the same item replaces the first. */
  fun notificationId(kind: String?, id: String?): Int = "${kind ?: ""}:${id ?: ""}".hashCode()
}
