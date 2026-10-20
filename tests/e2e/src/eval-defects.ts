import type { EvalTask } from "@forerunner/evals";
import { lastUserText, type ScriptedReply } from "@forerunner/testenv";
import { closingReply, criticTurn, submitReview } from "./world.ts";

/**
 * A scripted critic for the eval sets that judges from the evidence it is given. For every
 * task the marker is a line of the seeded-defect files that the reference solution does not
 * contain and that no clean fixture, brief or criterion of any task contains either; when the
 * critic's rendered evidence (the diff of the files on disk) carries that line, the script
 * returns findings and `revise`, otherwise it accepts. The script therefore proves the
 * plumbing: the eval runner's files reach the critic as a diff, the verdict rules in code apply,
 * and the calibration report counts what came back. It says nothing about a live model.
 */
export interface DefectMarker {
  taskId: string;
  file: string;
  /**
   * `added`: a line the defect adds that no clean fixture contains; `missing`: a line of the
   * reference solution the defect drops (a rename left half done, a guard removed), judged by
   * its absence from the diff.
   */
  kind: "added" | "missing";
  marker: string;
}

const MIN_MARKER_CHARS = 12;

/** Everything a clean review of any task could contain, so a marker is never found there. */
export function cleanCorpus(tasks: readonly EvalTask[]): string {
  const parts: string[] = [];
  for (const t of tasks) {
    parts.push(t.title, t.brief.goal, ...t.brief.constraints, ...t.brief.acceptanceCriteria);
    parts.push(...Object.values(t.setup.files));
    parts.push(...Object.values(t.expected_files ?? {}));
    parts.push(...Object.values(t.grader_files ?? {}));
    if (t.expected_final_text) parts.push(t.expected_final_text);
    if (t.expected_clean_output) parts.push(t.expected_clean_output);
    for (const c of t.checks) if (c.kind === "rubric") parts.push(...c.criteria);
  }
  return parts.join("\n");
}

/**
 * The most distinctive line the seeded defect adds; when every added line also occurs in a
 * clean fixture (a half-done rename, a guard dropped from a line), the longest line of the
 * reference solution the defect removes. Null only when the two files are identical.
 */
export function defectMarker(task: EvalTask, corpus: string): DefectMarker | null {
  const seeded = task.seeded_defect?.files ?? {};
  let added: DefectMarker | null = null;
  let missing: DefectMarker | null = null;
  for (const [file, content] of Object.entries(seeded)) {
    const expectedText = task.expected_files?.[file] ?? task.setup.files[file] ?? "";
    const expectedLines = expectedText.split(/\r?\n/).map((l) => l.trim());
    const expected = new Set(expectedLines);
    const got = new Set(content.split(/\r?\n/).map((l) => l.trim()));
    for (const line of got) {
      if (line.length < MIN_MARKER_CHARS || expected.has(line) || corpus.includes(line)) continue;
      if (!added || line.length > added.marker.length)
        added = { taskId: task.id, file, kind: "added", marker: line };
    }
    for (const line of expectedLines) {
      if (line.length < MIN_MARKER_CHARS || got.has(line) || content.includes(line)) continue;
      if (!missing || line.length > missing.marker.length)
        missing = { taskId: task.id, file, kind: "missing", marker: line };
    }
  }
  return added ?? missing;
}

/** Whether the rendered evidence of this task's review shows the defect. */
export function evidenceShowsDefect(text: string, marker: DefectMarker): boolean {
  if (marker.kind === "added") return text.includes(marker.marker);
  return text.includes(`Subject: task ${marker.taskId}`) && !text.includes(marker.marker);
}

export interface EvalCriticScript {
  replies: ScriptedReply[];
  markers: DefectMarker[];
  /** Tasks whose defect adds no distinctive line; their rule falls back to a failed check. */
  withoutMarker: string[];
}

export function evalCriticScript(tasks: readonly EvalTask[]): EvalCriticScript {
  const corpus = cleanCorpus(tasks);
  const markers: DefectMarker[] = [];
  const withoutMarker: string[] = [];
  const replies: ScriptedReply[] = [];
  for (const task of tasks) {
    const defect = task.seeded_defect;
    if (!defect) continue;
    const marker = defectMarker(task, corpus);
    if (marker) markers.push(marker);
    else withoutMarker.push(task.id);
    const subject = `Subject: task ${task.id}`;
    replies.push(
      submitReview(
        {
          grade: 35,
          confidence: "high",
          verdict: "revise",
          summary: `The diff shows the defect: ${defect.description}`,
          findings: [
            {
              severity: "major",
              what: `Seeded defect in ${task.id}: ${defect.description}`,
              required_action: `Fix it as described and show the evidence: ${defect.how_to_detect}`,
              ...(marker ? { where: marker.file } : {}),
            },
          ],
        },
        {
          when: (req) => {
            if (!criticTurn(req)) return false;
            const text = lastUserText(req);
            if (marker) return evidenceShowsDefect(text, marker);
            return text.includes(subject) && text.includes("[FAIL]");
          },
        },
      ),
    );
  }
  replies.push(
    submitReview({
      grade: 90,
      confidence: "high",
      verdict: "accept",
      summary:
        "The diff matches the brief, every mechanical check passed and the claims are backed by the files.",
    }),
    closingReply(),
  );
  return { replies, markers, withoutMarker };
}
