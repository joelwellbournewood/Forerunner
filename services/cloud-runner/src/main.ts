// Entry point for the headless runner. Filled in by the cloud-runner milestone; for now it
// starts, prints its identity and exits cleanly so the image smoke test has something to run.
import { log, osFacts } from "@forerunner/platform";

const logger = log("cloud-runner");
logger.info("forerunner runner starting", { ...osFacts() });
