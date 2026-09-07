/**
 * The bundle alchemy deploys for the api Worker — the entry alchemy would
 * generate for `./worker.ts`, written out because the chat Durable Object and
 * the two Workflows are still hand-written classes: a generated entry
 * re-exports only the classes alchemy's own forms register, so these would be
 * missing from the script their bindings name. The bridge is alchemy's own,
 * built around the same init; the stack identity it wants is what alchemy
 * binds into every Worker's env.
 *
 * Delete this file, and `isExternal` in `./worker.ts`, once those three move to
 * alchemy's Durable Object and Workflow forms.
 */
import { makeWorkerBridge } from "alchemy/Cloudflare"
import { env, WorkerEntrypoint } from "cloudflare:workers"
import MapleApi from "./worker.ts"

const boundString = (key: string, fallback: string): string => {
	const value: unknown = Reflect.get(env, key)
	return typeof value === "string" ? value : fallback
}

export default makeWorkerBridge(WorkerEntrypoint, {
	entrypoint: MapleApi,
	stack: {
		name: boundString("ALCHEMY_STACK_NAME", "maple"),
		stage: boundString("ALCHEMY_STAGE", "unknown"),
	},
})

// Cloudflare requires Durable Object and Workflow classes to be exported from
// the entry. Each is a thin shell that dynamic-imports its heavy logic, so
// these static exports keep module-scope evaluation light (startup-CPU budget).
export { ChatSession } from "./chat/ChatSession"
export { ClickHouseSchemaApplyWorkflow } from "./workflows/ClickHouseSchemaApplyWorkflow"
export { InvestigationFanoutWorkflow } from "./workflows/InvestigationFanoutWorkflow"
