import { CommandRegistry } from "../registry.ts";
import { autonomySet } from "./autonomy.ts";
import { budgetSet } from "./budget.ts";
import { capabilityGrant } from "./capability.ts";
import { deviceRevoke } from "./device.ts";
import { emailModeSet } from "./email.ts";
import { noteAdd } from "./note.ts";
import { projectCreate, projectSwitch } from "./project.ts";
import { requestAnswer } from "./request.ts";
import { sessionPause, sessionStart, sessionStop } from "./session.ts";
import { settingsSet } from "./settings.ts";
import { taskCreate, taskTransition } from "./task.ts";

export * from "./autonomy.ts";
export * from "./budget.ts";
export * from "./capability.ts";
export * from "./device.ts";
export * from "./email.ts";
export * from "./note.ts";
export * from "./project.ts";
export * from "./request.ts";
export * from "./session.ts";
export * from "./settings.ts";
export * from "./shared.ts";
export * from "./task.ts";

/** The registry with every built-in command. */
export function defaultRegistry(): CommandRegistry {
  return new CommandRegistry()
    .register(projectSwitch)
    .register(projectCreate)
    .register(taskCreate)
    .register(taskTransition)
    .register(budgetSet)
    .register(autonomySet)
    .register(sessionStart)
    .register(sessionStop)
    .register(sessionPause)
    .register(capabilityGrant)
    .register(settingsSet)
    .register(noteAdd)
    .register(requestAnswer)
    .register(emailModeSet)
    .register(deviceRevoke);
}
