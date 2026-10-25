import { existsSync } from "node:fs";
import type { SpecialistCommandPort } from "@forerunner/commands";
import { join } from "@forerunner/platform";
import { ACTIVATION_THRESHOLD, type SpecialistApprovals } from "../registry/approval.ts";
import {
  countEvalTasks,
  EVALS_DIR,
  PROPOSED_DIR,
  SPECIALIST_FILE,
  SPECIALISTS_DIR,
} from "../registry/loader.ts";

/**
 * The command registry's `specialists` port (spec C.5, ADR 0071): `specialist.propose`, the
 * principal agent's tool on the conversation agent's model path (and the palette's command),
 * reaches the approval gate through this adapter and nothing else. `propose` is
 * `SpecialistApprovals.propose`: the loader's checks on the exact bytes, `proposed/<name>/`
 * written with `status: proposed` (never runnable), one blocking approval request filed for
 * the install's human. Nothing here activates a specialist; the human's approve and a passing
 * eval set do, in the gate. `check` tells the card whether the name is free and how large the
 * eval set is; `withdraw` is the command's undo (`SpecialistApprovals.withdraw`).
 */
export interface SpecialistPortDeps {
  approvals: SpecialistApprovals;
  registryDir: string;
}

export function specialistCommandPort(deps: SpecialistPortDeps): SpecialistCommandPort {
  const { approvals, registryDir } = deps;
  return {
    async check(name) {
      const taken = existsSync(join(registryDir, SPECIALISTS_DIR, name, SPECIALIST_FILE))
        ? "active"
        : existsSync(join(registryDir, PROPOSED_DIR, name, SPECIALIST_FILE))
          ? "proposed"
          : null;
      return {
        name,
        taken,
        evalTaskCount: countEvalTasks(join(registryDir, EVALS_DIR, name)),
        minEvalTasks: ACTIVATION_THRESHOLD.minTasks,
        passRate: ACTIVATION_THRESHOLD.passRate,
      };
    },
    async propose(req) {
      const { receipt, request } = await approvals.propose(req);
      return {
        name: receipt.name,
        promptVersion: receipt.promptVersion,
        requestId: request.id,
        file: `${PROPOSED_DIR}/${receipt.name}/${SPECIALIST_FILE}`,
        evalSet: `${EVALS_DIR}/${receipt.name}`,
        evalTaskCount: receipt.evalTaskCount,
        minEvalTasks: ACTIVATION_THRESHOLD.minTasks,
        passRate: ACTIVATION_THRESHOLD.passRate,
      };
    },
    async withdraw({ name, humanId }) {
      const r = await approvals.withdraw(name, humanId);
      return { outcome: r.outcome };
    },
  };
}
