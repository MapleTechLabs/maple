import { Effect, Schema } from "effect"
import { LanguageModel, Prompt, type Response, type Tool } from "effect/ai"
import { OrgId, UserId } from "@maple/domain/http"
import { McpToolNotFoundError } from "@maple/domain/mcp-tool-contract"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import type { McpToolExecutorApi } from "../dispatcher"
import { buildMapleToolkit } from "../tools/llm-tools"
import type { TaskResult, ToolCall } from "./harness"
import { evalModelLayer } from "./model"

/** Stable identifiers used across eval prompts + fixtures. */
export const FIXTURES = {
	orgId: "org_eval",
	service: "api",
	traceId: "0af7651916cd43dd8448eb211c80319c",
	spanId: "b7ad6b7169203331",
	/**
	 * A FingerprintHash is a UInt64 rendered as a DECIMAL string
	 * (`CH.toString_($.FingerprintHash)`), not hex — hex was what this fixture
	 * used, and it is the same wrong mental model that makes agents feed
	 * `error_detail` a truncated issue id in production.
	 */
	fingerprint: "11640295108927840024",
	/** A Postgres error-issue id. A DIFFERENT identity space to `fingerprint`. */
	issueId: "2b11d788-6f3a-4c21-9f0e-51c4a8d7e930",
} as const

export const EVAL_TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)(FIXTURES.orgId),
	userId: Schema.decodeSync(UserId)("internal-service"),
	roles: [],
	authMode: "self_hosted",
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const toToolCall = (part: { readonly name: string; readonly params: unknown }): ToolCall => ({
	name: part.name,
	arguments: isRecord(part.params) ? part.params : {},
})

/** Prediction never resolves a call, so nothing reaches the executor. */
const unreachableExecutor: McpToolExecutorApi = {
	execute: (_tenant, name) =>
		Effect.fail(new McpToolNotFoundError({ name, message: `prediction evals never execute ${name}` })),
	prepareRepository: () => Effect.void,
	prepareConnectedRepositories: () => Effect.void,
}

/**
 * Prediction task: offer the model the MCP surface's tools, exactly as the agents' toolkit builds
 * them, and record which it calls for `input` without running any.
 */
export const predictToolCalls = (input: string): Promise<TaskResult> => {
	const { toolkit } = buildMapleToolkit(unreachableExecutor, EVAL_TENANT, { surface: "mcp" })
	return LanguageModel.generateText({ prompt: input, toolkit, disableToolCallResolution: true }).pipe(
		Effect.map((response) => ({ output: response.text, toolCalls: response.toolCalls.map(toToolCall) })),
		Effect.provide(evalModelLayer()),
		Effect.runPromise,
	)
}

interface Transcript {
	readonly text: string
	readonly toolCalls: ReadonlyArray<ToolCall>
	readonly toolOutputs: ReadonlyArray<string>
}

const toolOutput = (part: Response.ToolResultPart<string, unknown, unknown>): string =>
	typeof part.result === "string" ? part.result : ""

/**
 * Full-execution task: the model calls tools for real through `executor`, for up to `maxSteps`
 * model turns, and the transcript keeps every call and every rendered result the model was shown.
 */
export const runToolLoop = (executor: McpToolExecutorApi, input: string, maxSteps: number) => {
	const { toolkit, layer } = buildMapleToolkit(executor, EVAL_TENANT, { surface: "mcp" })
	const step = (
		prompt: Prompt.Prompt,
		remaining: number,
		so: Transcript,
	): Effect.Effect<Transcript, unknown, LanguageModel.LanguageModel | Tool.Handler<string>> =>
		LanguageModel.generateText({ prompt, toolkit }).pipe(
			Effect.flatMap((response) => {
				const next: Transcript = {
					text: response.text,
					toolCalls: [...so.toolCalls, ...response.toolCalls.map(toToolCall)],
					toolOutputs: [...so.toolOutputs, ...response.toolResults.map(toolOutput)],
				}
				return response.finishReason === "tool-calls" && remaining > 1
					? step(
							Prompt.concat(prompt, Prompt.fromResponseParts(response.content)),
							remaining - 1,
							next,
						)
					: Effect.succeed(next)
			}),
		)
	return step(Prompt.make(input), maxSteps, { text: "", toolCalls: [], toolOutputs: [] }).pipe(
		Effect.provide(layer),
		Effect.provide(evalModelLayer()),
	)
}
