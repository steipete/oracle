import type { Command } from "commander";
import { registerBrowserLeasesCommand } from "./commands/leases/index.js";
import { registerCapabilitiesCommand } from "./commands/capabilities.js";
import { registerDoctorCommand, type DoctorCommandDeps } from "./commands/doctor/index.js";
import { registerEvidenceCommand, type EvidenceCommandOptions } from "./commands/evidence/index.js";
import { registerPreviewCommand } from "./commands/preview.js";
import { registerRobotDocsCommand } from "./commands/robotDocs.js";
import {
  registerProtectedRunCommand,
  type ProtectedRunCommandDeps,
} from "./commands/run/protected.js";
import { registerStatusVisibilityCommand } from "./commands/statusVisibility.js";
import type { BrowserLeaseStoreOptions } from "../browser/leases.js";

export interface CliCommandDeps {
  browserLeases?: BrowserLeaseStoreOptions;
  doctor?: DoctorCommandDeps;
  evidence?: EvidenceCommandOptions;
  protectedRun?: ProtectedRunCommandDeps;
}

export function registerCliCommands(program: Command, deps: CliCommandDeps = {}): Command {
  registerCapabilitiesCommand(program);
  registerDoctorCommand(program, deps.doctor);
  registerBrowserLeasesCommand(program, deps.browserLeases);
  registerEvidenceCommand(program, deps.evidence);
  registerPreviewCommand(program);
  registerRobotDocsCommand(program);
  registerProtectedRunCommand(program, deps.protectedRun);
  registerStatusVisibilityCommand(program);
  return program;
}

export { registerBrowserLeasesCommand } from "./commands/leases/index.js";
export { registerCapabilitiesCommand } from "./commands/capabilities.js";
export { registerDoctorCommand } from "./commands/doctor/index.js";
export { registerEvidenceCommand } from "./commands/evidence/index.js";
export { registerPreviewCommand } from "./commands/preview.js";
export { registerProtectedRunCommand } from "./commands/run/protected.js";
export { registerRobotDocsCommand } from "./commands/robotDocs.js";
export { registerStatusVisibilityCommand } from "./commands/statusVisibility.js";
