import { Command } from "commander";
import { runAggregateDoctor, type AggregateDoctorOptions } from "./aggregate.js";
import { registerChatGptDoctorCommand, type ChatGptDoctorOptions } from "./chatgpt.js";
import { registerGeminiDoctorCommand, type GeminiDoctorOptions } from "./gemini.js";

export interface DoctorCommandDeps {
  aggregate?: Partial<AggregateDoctorOptions>;
  chatgpt?: Partial<ChatGptDoctorOptions>;
  gemini?: Partial<GeminiDoctorOptions>;
}

export function registerDoctorCommand(program: Command, deps: DoctorCommandDeps = {}): Command {
  const doctorCommand = program
    .command("doctor")
    .description("Run Oracle preflight diagnostics without submitting prompts.")
    .option("--json", "Print structured JSON.", false)
    .action(async (options: AggregateDoctorOptions) => {
      const envelope = await runAggregateDoctor({ ...deps.aggregate, ...options });
      if (!envelope.ok) {
        process.exitCode = 1;
      }
    });

  registerChatGptDoctorCommand(doctorCommand, deps.chatgpt);
  registerGeminiDoctorCommand(doctorCommand, deps.gemini);
  return doctorCommand;
}

export { runAggregateDoctor } from "./aggregate.js";
export type {
  AggregateDoctorCheck,
  AggregateDoctorEnvelope,
  AggregateDoctorOptions,
} from "./aggregate.js";
