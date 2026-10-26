package app.forerunner.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * JVM unit tests for the edge-to-edge padding (R.1; the rc.3 APK drew under the status bar on
 * a Samsung SM-S911B). They run with `./gradlew :app:testX86_64DebugUnitTest` in android.yml.
 */
class SafeAreaTest {
  @Test
  fun aPortraitPhoneIsPaddedBelowTheStatusBarAndAboveTheNavigationBar() {
    val bars = Edges(0, 110, 0, 63)
    assertEquals(Edges(0, 110, 0, 63), SafeArea.padding(bars, Edges.ZERO, Edges.ZERO))
  }

  @Test
  fun aCutoutTallerThanTheStatusBarWins() {
    val bars = Edges(0, 80, 0, 63)
    val cutout = Edges(0, 120, 0, 0)
    assertEquals(Edges(0, 120, 0, 63), SafeArea.padding(bars, cutout, Edges.ZERO))
  }

  @Test
  fun aLandscapeCutoutPadsTheSideItIsOn() {
    val bars = Edges(0, 0, 132, 0)
    val cutout = Edges(110, 0, 0, 0)
    assertEquals(Edges(110, 0, 132, 0), SafeArea.padding(bars, cutout, Edges.ZERO))
  }

  @Test
  fun theOpenKeyboardReplacesTheNavigationBarAtTheBottomRatherThanAddingToIt() {
    val bars = Edges(0, 110, 0, 63)
    val ime = Edges(0, 0, 0, 900)
    assertEquals(Edges(0, 110, 0, 900), SafeArea.padding(bars, Edges.ZERO, ime))
  }

  @Test
  fun noInsetsMeansNoPadding() {
    assertEquals(Edges.ZERO, SafeArea.padding(Edges.ZERO, Edges.ZERO, Edges.ZERO))
  }
}
