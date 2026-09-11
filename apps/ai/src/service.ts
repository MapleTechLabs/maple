import { summarizeCause } from "./runtime/failures"
// BOUNDARY: Private RPC validates data before agent execution; callbacks are caller-scoped capabilities.
import {
	AiChatInput,
	InvokePlannerInput,
	InvokeHypothesisInput,
	InvokeValidatorInput,
	AiServiceError,
	AiToolDescriptor,
	makeRunUsage,
	type AiServiceRpc,
	type AiToolCallbacks,
} from "@maple/domain/ai-service"
import { encodeChatEventPayload } from "@maple/domain/chat-session"
import { SubmitDiagnosisRequest } from "@maple/domain/http"
import { Effect, Layer, Schema, type Context } from "effect"
import { runChatTurn } from "./chat/run"
import { layerLlm, resolveTriageModel, type LlmEnv, type LlmClients } from "./platform/Llm"
import { callbackExecutor, ToolExecutor } from "./runtime/tool-executor"
import { plannerOn, hypothesisOn, validatorOn } from "./investigations/passes"

const decodeTools = Schema.decodeUnknownEffect(Schema.Array(AiToolDescriptor))
const failed = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AiServiceError, R> =>
	effect.pipe(
		Effect.tapCause((cause) =>
			Effect.logError("AI execution failed").pipe(
				Effect.annotateLogs({ cause: summarizeCause(cause) }),
			),
		),
		Effect.catchCause(() => Effect.fail(new AiServiceError({ message: "AI execution failed" }))),
	)

export const makeAiService = (env: LlmEnv): AiServiceRpc => {
	const clients = layerLlm(env)
	const pass = <I extends { orgId: string; investigationId: string; deadlineAtMs: number }, O>(
		input: I,
		tools: ReadonlyArray<AiToolDescriptor>,
		callbacks: AiToolCallbacks,
		run: (
			context: Context.Context<LlmClients | ToolExecutor>,
			env: LlmEnv,
		) => (input: I) => Effect.Effect<O, Schema.SchemaError>,
	) =>
		Effect.gen(function* () {
			const descriptors = yield* decodeTools(tools)
			const context = yield* Layer.build(
				Layer.mergeAll(
					clients,
					Layer.succeed(ToolExecutor, callbackExecutor(descriptors, callbacks)),
				),
			)
			return yield* run(context, env)(input)
		}).pipe(Effect.scoped)

	return {
		plan: (input, tools, callbacks) =>
			failed(
				Schema.decodeUnknownEffect(InvokePlannerInput)(input).pipe(
					Effect.flatMap((decoded) => pass(decoded, tools, callbacks, plannerOn)),
				),
			),
		hypothesis: (input, tools, callbacks) =>
			failed(
				Schema.decodeUnknownEffect(InvokeHypothesisInput)(input).pipe(
					Effect.flatMap((decoded) => pass(decoded, tools, callbacks, hypothesisOn)),
				),
			),
		validate: (input, tools, callbacks) =>
			failed(
				Schema.decodeUnknownEffect(InvokeValidatorInput)(input).pipe(
					Effect.flatMap((decoded) => pass(decoded, tools, callbacks, validatorOn)),
				),
			),
		chat: (raw, callbacks) =>
			failed(
				Effect.gen(function* () {
					const input = yield* Schema.decodeUnknownEffect(AiChatInput)(raw)
					const usage = makeRunUsage()
					let active = true
					const publish = (events: ReadonlyArray<string>) =>
						Effect.tryPromise({
							try: async () => {
								active = await callbacks.publish(events, { ...usage })
							},
							catch: () =>
								new AiServiceError({ message: "Chat publication callback unavailable" }),
						})
					const model = resolveTriageModel(env, {
						surface: "chat",
						orgId: input.tenant.orgId,
						sessionId: input.sessionId,
						turnId: input.messageId,
					})
					yield* runChatTurn({
						...input,
						model,
						toolExecutor: callbackExecutor(input.tools, callbacks),
						usage,
						holdsTurn: () => active,
						append: (events) => publish(events.map(encodeChatEventPayload)),
						submitDiagnosis: (_orgId, _investigationId, request) =>
							Effect.tryPromise({
								try: () =>
									callbacks.submitDiagnosis(
										Schema.encodeSync(SubmitDiagnosisRequest)(request),
									),
								catch: () =>
									new AiServiceError({ message: "Report submission callback unavailable" }),
							}),
					}).pipe(
						// Each RPC owns its model clients for the run.
						// oxlint-disable-next-line effecttsgo/strict-effect-provide
						Effect.provide(clients),
						Effect.ensuring(
							publish([]).pipe(
								Effect.tapError(() =>
									Effect.logWarning("Final chat usage publication failed"),
								),
								Effect.ignore,
							),
						),
					)
				}),
			),
	}
}
