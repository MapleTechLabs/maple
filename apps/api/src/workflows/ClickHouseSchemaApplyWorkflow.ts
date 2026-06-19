import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type {
	SchemaApplyWorkflowEnv,
	SchemaApplyWorkflowPayload,
	SchemaApplyWorkflowResult,
} from "./ClickHouseSchemaApplyWorkflow.run"

/**
 * Cloudflare Workflow that applies Maple's ClickHouse schema to a customer's BYO
 * cluster, chunking heavy backfills across durable steps so they never hit the
 * Worker subrequest budget.
 *
 * The class is a thin shell: the heavy logic (which imports `@maple/domain`'s
 * schema graph) is DYNAMICALLY imported inside `run()`, so the worker's
 * module-evaluation stays under Cloudflare's ~1s startup-CPU budget (the
 * workflow class is statically exported from `worker.ts`).
 */
export class ClickHouseSchemaApplyWorkflow extends WorkflowEntrypoint<
	SchemaApplyWorkflowEnv,
	SchemaApplyWorkflowPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<SchemaApplyWorkflowPayload>>,
		step: WorkflowStep,
	): Promise<SchemaApplyWorkflowResult> {
		const { runClickHouseSchemaApply } = await import("./ClickHouseSchemaApplyWorkflow.run")
		return runClickHouseSchemaApply(this.env, event, step)
	}
}
