import { jsonSchema, tool, type ToolSet } from "ai"
import { Effect, Layer, Schema, type ManagedRuntime } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { AiTriageResult } from "@maple/domain/http"
import type { MapleAgentSetup } from "../agent"

/**
 * Read-only investigation subset of the Maple tool registry for the headless
 * triage agent. Everything that mutates state (dashboards, alert rules, issue
 * transitions, fix proposals) and the session-replay tools are excluded — the
 * agent's only output channel is `submit_triage`.
 */
export const TRIAGE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"diagnose_service",
	"error_detail",
	"find_errors",
	"inspect_trace",
	"inspect_span",
	"search_traces",
	"find_slow_traces",
	"search_logs",
	"mine_log_patterns",
	"compare_periods",
	"service_map",
	"get_service_top_operations",
	"list_services",
	"explore_attributes",
	"list_metrics",
	"query_data",
	"get_incident_timeline",
	"list_error_issue_events",
])

export const SUBMIT_TRIAGE_TOOL_NAME = "submit_triage"

const createInternalToolRequest = (orgId: string, internalServiceToken: string) =>
	new Request("https://maple-ai-triage.internal/mcp", {
		headers: {
			Authorization: `Bearer maple_svc_${internalServiceToken}`,
			"X-Org-Id": orgId,
		},
	})

export interface BuildTriageToolSetOptions {
	readonly setup: Pick<MapleAgentSetup, "runtime" | "mapleToolDefinitions" | "toInputSchema">
	readonly orgId: string
	readonly internalServiceToken: string
}

/**
 * The agent's ToolSet: the read-only registry subset executing through the
 * Maple agent runtime (internal-service-token tenant), plus a local
 * `submit_triage` tool whose call ends the loop — its input is the structured
 * triage result.
 */
export const buildTriageToolSet = ({
	setup,
	orgId,
	internalServiceToken,
}: BuildTriageToolSetOptions): ToolSet => {
	const requestLayer = Layer.succeed(
		HttpServerRequest.HttpServerRequest,
		HttpServerRequest.fromWeb(createInternalToolRequest(orgId, internalServiceToken)),
	)

	const investigationTools = Object.fromEntries(
		setup.mapleToolDefinitions
			.filter((definition) => TRIAGE_TOOL_NAMES.has(definition.name))
			.map((definition) => [
				definition.name,
				tool({
					description: definition.description,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					inputSchema: jsonSchema(setup.toInputSchema(definition.schema) as any),
					execute: async (input: unknown) => {
						try {
							const decoded = Schema.decodeUnknownSync(definition.schema)(input)
							return await (
								setup.runtime as ManagedRuntime.ManagedRuntime<unknown, never>
							).runPromise(definition.handler(decoded).pipe(Effect.provide(requestLayer)))
						} catch (error) {
							const message = Schema.isSchemaError(error)
								? `Invalid parameters: ${String(error)}`
								: error instanceof Error
									? error.message
									: String(error)
							return {
								isError: true,
								content: [{ type: "text" as const, text: message }],
							}
						}
					},
				}),
			]),
	)

	return {
		...investigationTools,
		[SUBMIT_TRIAGE_TOOL_NAME]: tool({
			description:
				"Submit your final structured triage result. Call this EXACTLY ONCE when your investigation is complete — it ends the run.",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			inputSchema: jsonSchema(setup.toInputSchema(AiTriageResult) as any),
			execute: async (input: unknown) => input,
		}),
	}
}

export const decodeTriageResult = Schema.decodeUnknownSync(AiTriageResult)
