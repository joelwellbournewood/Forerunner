// A helper that never exits on its own: it ignores stdin closing, so HelperProcess.stop()
// has to kill it after the grace period. Used to test the grace timer on the injected Clock.
process.stdin.resume();
process.stdin.on("end", () => {
  // deliberately keep running
});
setInterval(() => {}, 1000);
process.stdout.write("ready\n");
