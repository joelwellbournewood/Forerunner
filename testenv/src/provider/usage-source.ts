import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";

export interface FakeUsageStatus {
  available: boolean;
  /** 0..1 share of the plan limit used so far. */
  planUsageShare: number;
  checkedAt: string;
}

/**
 * Stand-in for a subscription usage probe in billing tests: a plan usage share the test moves
 * by hand. Structurally compatible with billing's `BillingSourceProbe` (a `status()` returning a
 * `BillingSourceStatus`) without importing it, so testenv stays free of billing at runtime.
 */
export class FakeUsageSource {
  planUsageShare: number;
  available = true;
  private readonly clock: Clock;

  constructor(planUsageShare = 0, clock: Clock = systemClock) {
    this.clock = clock;
    this.planUsageShare = FakeUsageSource.check(planUsageShare);
  }

  /** Move the share, e.g. to simulate a plan filling up during a simulated week. */
  set(planUsageShare: number): this {
    this.planUsageShare = FakeUsageSource.check(planUsageShare);
    return this;
  }

  async status(): Promise<FakeUsageStatus> {
    return {
      available: this.available,
      planUsageShare: this.planUsageShare,
      checkedAt: this.clock.nowIso(),
    };
  }

  private static check(share: number): number {
    if (!Number.isFinite(share) || share < 0 || share > 1) {
      throw new ForerunnerError("validation", "planUsageShare must be between 0 and 1", {
        details: { planUsageShare: share },
      });
    }
    return share;
  }
}
