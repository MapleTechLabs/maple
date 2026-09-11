import {
	AiServiceError,
	type AiServiceRpc,
	type AiToolCallbacks,
	type AiToolDescriptor,
} from "@maple/domain/ai-service"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import { listMcpTools, type McpToolExecutorApi, type McpToolSurface } from "@/mcp/dispatcher"
import { MUTATING_TOOL_NAMES } from "@/mcp/tools/mutating"
import type { TenantContext } from "@/services/auth/tenant-context"

export const aiService = (env: Record<string, unknown>): AiServiceRpc => {
	const remote = Cloudflare.makeRpcStub<AiServiceRpc>(env.MAPLE_AI)
	const call = <A>(method: string, run: () => Effect.Effect<A, AiServiceError>) =>
		Effect.suspend(() =>
			env.MAPLE_AI === undefined
				? Effect.fail(new AiServiceError({ message: "AI service binding is unavailable" }))
				: run().pipe(
						Effect.catchCause(() =>
							Effect.fail(new AiServiceError({ message: `AI ${method} failed` })),
						),
					),
		).pipe(
			Effect.withSpan(`AiService.${method}`, {
				kind: "client",
				attributes: { "peer.service": "maple-ai" },
			}),
		)
	return {
		chat: (...args) => call("chat", () => remote.chat(...args)),
		plan: (...args) => call("plan", () => remote.plan(...args)),
		hypothesis: (...args) => call("hypothesis", () => remote.hypothesis(...args)),
		validate: (...args) => call("validate", () => remote.validate(...args)),
	}
}

/** Descriptors carry no handlers or credentials. The API remains the authority on mutations. */
export const aiTools = Effect.map(
	listMcpTools,
	(tools): ReadonlyArray<AiToolDescriptor> =>
		tools.map((tool) => ({ ...tool, mutating: MUTATING_TOOL_NAMES.has(tool.name) })),
)

/** This capability cannot select a different tenant, surface or turn. */
export const toolCallbacks = (
	executor: McpToolExecutorApi,
	tenant: TenantContext,
	surface: McpToolSurface,
	active: () => boolean = () => true,
) =>
	Effect.gen(function* () {
		const context = yield* Effect.context<never>()
		return {
			execute: (name: string, input: unknown) =>
				Effect.runPromiseWith(context)(
					Effect.gen(function* () {
						if (!active())
							return yield* Effect.fail(
								new AiServiceError({ message: "Run is no longer active" }),
							)
						if (MUTATING_TOOL_NAMES.has(name)) {
							return {
								isError: true,
								content: [
									{
										type: "text" as const,
										text: `${name} requires user approval and was not executed.`,
									},
								],
							}
						}
						// The dispatcher validates the name and parameters against the authoritative registry.
						return yield* executor.execute(tenant, name, input, surface)
					}),
				),
		} satisfies AiToolCallbacks
	})
