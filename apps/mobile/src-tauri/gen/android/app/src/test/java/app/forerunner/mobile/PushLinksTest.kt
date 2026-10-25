package app.forerunner.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the FCM rules (ADR 0085 point 8). They run with
 * `./gradlew :app:testX86_64DebugUnitTest` (android.yml runs it after the APK build); the
 * Firebase classes themselves are only compiled there, never unit-tested.
 */
class PushLinksTest {
  @Test
  fun aPlainAppPathBecomesTheOpenDeepLink() {
    assertEquals("fr://open?link=%2Finbox", PushLinks.deepLink("/inbox"))
    assertEquals("fr://open?link=%2Fsessions%2Fses_1", PushLinks.deepLink("/sessions/ses_1"))
  }

  @Test
  fun anythingElseOpensNothing() {
    val refused =
      listOf(
        null,
        "",
        "inbox",
        "https://evil.example/",
        "//evil.example/x",
        "/../etc",
        "/a/./b",
        "/inbox?x=1",
        "/inbox#x",
        "javascript:alert(1)",
        "/" + "a".repeat(300),
      )
    for (link in refused) {
      assertNull("link $link", PushLinks.safeLink(link))
      assertNull("link $link", PushLinks.deepLink(link))
    }
  }

  @Test
  fun theFourKindsAndTheirChannels() {
    for (kind in listOf("approval", "session", "budget", "message")) {
      assertTrue(PushLinks.isKnownKind(kind))
    }
    assertFalse(PushLinks.isKnownKind("other"))
    assertFalse(PushLinks.isKnownKind(null))
    assertEquals(PushLinks.CHANNEL_ATTENTION, PushLinks.channelFor("approval"))
    assertEquals(PushLinks.CHANNEL_ATTENTION, PushLinks.channelFor("budget"))
    assertEquals(PushLinks.CHANNEL_UPDATES, PushLinks.channelFor("session"))
    assertEquals(PushLinks.CHANNEL_UPDATES, PushLinks.channelFor("message"))
    assertEquals("Session finished", PushLinks.defaultTitle("session"))
  }

  @Test
  fun oneNotificationPerItem() {
    assertEquals(
      PushLinks.notificationId("approval", "req_1"),
      PushLinks.notificationId("approval", "req_1"),
    )
    assertNotEquals(
      PushLinks.notificationId("approval", "req_1"),
      PushLinks.notificationId("approval", "req_2"),
    )
  }
}
