package app.forerunner.mobile

/** One inset per edge, in pixels. */
data class Edges(val left: Int, val top: Int, val right: Int, val bottom: Int) {
  companion object {
    val ZERO = Edges(0, 0, 0, 0)
  }
}

/**
 * The padding that keeps the WebView clear of what Android 15+ draws over an edge-to-edge app
 * (targetSdk 35+): the status and navigation bars, a display cutout and the on-screen keyboard.
 * Each edge takes the largest of the three, since they overlap rather than stack (the keyboard's
 * bottom inset already includes the navigation bar; a cutout sits inside the status bar).
 * Pure so it runs in the JVM unit tests (SafeAreaTest); MainActivity feeds it the insets.
 */
object SafeArea {
  fun padding(systemBars: Edges, cutout: Edges, ime: Edges): Edges =
    Edges(
      left = maxOf(systemBars.left, cutout.left, ime.left),
      top = maxOf(systemBars.top, cutout.top, ime.top),
      right = maxOf(systemBars.right, cutout.right, ime.right),
      bottom = maxOf(systemBars.bottom, cutout.bottom, ime.bottom),
    )
}
