/**
 * The on-screen indicator (spec: "shows a visible on-screen indicator while active"). The
 * shells implement the port with a visible banner or overlay; the controller turns it on before
 * the first action and off after the last one, on run end and on revoke. The fallback logs,
 * so a missing shell never makes the controller skip the call order.
 */
import { type Logger, log } from "@forerunner/platform";

export interface IndicatorReason {
  agentId: string;
  sessionId: string;
  runId: string;
  humanId: string;
  /** Executable of the application being controlled, when known. */
  app?: string;
  message: string;
  at: string;
}

export interface Indicator {
  on(reason: IndicatorReason): Promise<void> | void;
  off(): Promise<void> | void;
}

export interface IndicatorEvent {
  type: "on" | "off";
  reason?: IndicatorReason;
}

/** For tests and for the daemon's status view: remembers every transition. */
export class RecordingIndicator implements Indicator {
  readonly events: IndicatorEvent[] = [];
  private active = false;
  constructor(private readonly onEvent?: (event: IndicatorEvent) => void) {}
  get isOn(): boolean {
    return this.active;
  }
  on(reason: IndicatorReason): void {
    this.active = true;
    const event: IndicatorEvent = { type: "on", reason };
    this.events.push(event);
    this.onEvent?.(event);
  }
  off(): void {
    this.active = false;
    const event: IndicatorEvent = { type: "off" };
    this.events.push(event);
    this.onEvent?.(event);
  }
}

/** Fallback when no shell is attached: a warning line per transition. */
export class LogIndicator implements Indicator {
  private readonly logger: Logger;
  constructor(logger?: Logger) {
    this.logger = logger ?? log("desktop.indicator");
  }
  on(reason: IndicatorReason): void {
    this.logger.warn("desktop control active", { ...reason });
  }
  off(): void {
    this.logger.warn("desktop control inactive", {});
  }
}

/** Several shells (tray, window, approvals web) can show the indicator at once. */
export class CompositeIndicator implements Indicator {
  constructor(private readonly indicators: readonly Indicator[]) {}
  async on(reason: IndicatorReason): Promise<void> {
    for (const i of this.indicators) await i.on(reason);
  }
  async off(): Promise<void> {
    for (const i of this.indicators) await i.off();
  }
}
