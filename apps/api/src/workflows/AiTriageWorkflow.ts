import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type {
	AiTriageWorkflowEnv,
	AiTriageWorkflowPayload,
	AiTriageWorkflowResult,
} from "./AiTriageWorkflow.run"

export type {
	AiTriageWorkflowEnv,
	AiTriageWorkflowPayload,
	AiTriageWorkflowResult,
} from "./AiTriageWorkflow.run"

/**
 * Cloudflare Workflow that runs the headless AI triage agent for a freshly
 * opened incident (error or anomaly), org opt-in.
 *
 * The class is a thin shell: the heavy logic (agent runtime, AI SDK, tool
 * registry) is DYNAMICALLY imported inside `run()`, so the worker's
 * module-evaluation stays under Cloudflare's ~1s startup-CPU budget (the
 * workflow class is statically exported from `worker.ts`).
 */
export class AiTriageWorkflow extends WorkflowEntrypoint<
	AiTriageWorkflowEnv,
	AiTriageWorkflowPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<AiTriageWorkflowPayload>>,
		step: WorkflowStep,
	): Promise<AiTriageWorkflowResult> {
		const { runAiTriage } = await import("./AiTriageWorkflow.run")
		return runAiTriage(this.env, event, step)
	}
}
