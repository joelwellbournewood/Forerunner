import { useRef, useState } from "react";
import { Link } from "react-router";
import type { TaskView } from "../../api/client.ts";
import { Conversation } from "../../components/Conversation.tsx";
import { buttonClassName } from "../../components/ui.tsx";
import type { MoneyLike } from "../../lib/money.ts";
import { NewTaskDialog, seedFromMessage, type TaskSeed } from "./NewTaskDialog.tsx";

/**
 * The project's Chat tab (design §3.9): the project's one conversation, the same one Talk
 * shows on this project's pages, kept by the daemon. "Make this a task" under the person's own
 * lines opens New task prefilled with the line (U-016); the task is ready for the next session.
 */
export function ChatTab({
  projectId,
  reference,
  defaultRiskTier,
  closed = null,
}: {
  projectId: string;
  reference?: MoneyLike;
  /** The project card's default tier for a new task, named on the dialog's default option. */
  defaultRiskTier?: number;
  /**
   * OJ-06 (d1109-onerepo-join): a project closed into another (or removed) takes no new work, so
   * its conversation is kept to read: no message box, no examples, no Make this a task, and one
   * line says where to ask ('This chat is kept to read; ask about its work in the Chat of
   * "Site".'), with Open it to that Chat.
   */
  closed?: { text: string; to: string | null } | null;
}) {
  const [seed, setSeed] = useState<TaskSeed | null>(null);
  const [created, setCreated] = useState<TaskView | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (closed) {
    return (
      <div className="flex h-full min-h-[24rem] flex-col gap-2">
        <p
          className="flex flex-wrap items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400"
          data-testid="chat-closed"
        >
          {closed.text}
          {closed.to ? (
            <Link to={closed.to} className={buttonClassName("secondary")}>
              Open it
            </Link>
          ) : null}
        </p>
        <div className="min-h-0 flex-1">
          <Conversation projectId={projectId} testIds="chat" readOnly />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[24rem] flex-col gap-2">
      <p className="text-xs text-neutral-500" data-testid="chat-intro">
        Ask what is going on, what failed and why, or what is left. Tell me what to change: a change
        to a task is read back once and waits for your Yes.
      </p>
      <div className="min-h-0 flex-1">
        <Conversation
          projectId={projectId}
          testIds="chat"
          inputRef={inputRef}
          onMakeTask={(text) => setSeed(seedFromMessage(text))}
        />
      </div>
      {created ? (
        <output
          className="text-xs text-emerald-700 dark:text-emerald-300"
          data-testid="task-created"
        >
          {created.status === "draft" ? "Draft task" : "Task"} created: {created.title} ·{" "}
          <Link to={`/projects/${encodeURIComponent(projectId)}/tasks`} className="underline">
            open tasks
          </Link>
        </output>
      ) : null}
      <NewTaskDialog
        open={seed !== null}
        onClose={() => setSeed(null)}
        projectId={projectId}
        seed={seed}
        reference={reference}
        defaultRiskTier={defaultRiskTier}
        onCreated={(task) => setCreated(task)}
      />
    </div>
  );
}
