import type { ModelMessage, StreamTextOnFinishCallback, StreamTextResult, ToolSet } from "ai"
import { Clock, Effect, Queue, Ref } from "effect"
import { compactSnapshot } from "./compaction"
import { type AgentHarnessError, AgentHarnessModelError } from "./errors"
import {
	buildSessionContext,
	createEmptySnapshot,
	estimateMessageTokens,
	estimateTextTokens,
	toSessionUsage,
} from "./session-context"
import type {
	AgentModelGatewayShape,
	AgentPromptInput,
	AgentSessionStoreShape,
	AgentToolRegistryShape,
	HarnessCommand,
	SessionEntry,
	SessionSnapshot,
} from "./types"

export interface AgentHarnessRuntime {
	readonly prompt: <TOOLS extends ToolSet>(
		input: AgentPromptInput & {
			readonly tools: TOOLS
			readonly onFinish?: StreamTextOnFinishCallback<TOOLS>
		},
	) => Effect.Effect<
		{
			readonly result: StreamTextResult<TOOLS, any>
			readonly snapshot: SessionSnapshot
		},
		AgentHarnessModelError
	>
	readonly compactNow: (
		turnId: string,
		abortSignal?: AbortSignal,
	) => Effect.Effect<SessionSnapshot, AgentHarnessError>
	readonly continue: (text: string) => Effect.Effect<void>
	readonly steer: (text: string) => Effect.Effect<void>
	readonly followUp: (text: string) => Effect.Effect<void>
	readonly abort: () => Effect.Effect<void>
	readonly state: Effect.Effect<SessionSnapshot>
}

const appendUserMessage = (
	snapshot: SessionSnapshot,
	turnId: string,
	text: string,
	now: number,
): ReadonlyArray<SessionEntry> => [
	{
		id: `${snapshot.sessionId}:${turnId}:user`,
		createdAt: now,
		turnId,
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text }],
		} satisfies ModelMessage,
		estimatedTokens: estimateTextTokens(text),
	},
]

const toResponseEntries = (
	sessionId: string,
	turnId: string,
	messages: ReadonlyArray<ModelMessage>,
	now: number,
): ReadonlyArray<SessionEntry> =>
	messages.map((message, index) => ({
		id: `${sessionId}:${turnId}:response:${index}`,
		createdAt: now,
		turnId,
		type: "message" as const,
		message,
		estimatedTokens: estimateMessageTokens(message),
	}))

const enqueueCommand = <K extends HarnessCommand["kind"]>(
	queue: Queue.Queue<HarnessCommand>,
	kind: K,
	text: string,
) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		yield* Queue.offer(queue, {
			id: `${kind}:${now}`,
			kind,
			text,
			createdAt: now,
		} satisfies HarnessCommand)
	})

/**
 * Build an {@link AgentHarnessRuntime} bound to the given session, store, model
 * gateway, and tool registry. Returns an Effect — callers `yield*` it so the
 * underlying queue/ref allocation happens inside the Effect runtime rather than
 * via a synchronous `Effect.runSync` at construction time.
 */
export const makeAgentHarnessRuntime = Effect.fn("AgentHarness.make")(function* (
	sessionId: string,
	store: AgentSessionStoreShape,
	modelGateway: AgentModelGatewayShape,
	_toolRegistry: AgentToolRegistryShape,
) {
	const commandQueue = yield* Queue.unbounded<HarnessCommand>()
	const snapshotRef = yield* Ref.make<SessionSnapshot>(createEmptySnapshot(sessionId))
	const activeAbortRef = yield* Ref.make<AbortController | undefined>(undefined)

	const loadSnapshot = store
		.load(sessionId)
		.pipe(Effect.tap((snapshot) => Ref.set(snapshotRef, snapshot)))

	const compactNow = Effect.fn("AgentHarness.compactNow")(function* (
		turnId: string,
		abortSignal?: AbortSignal,
	) {
		const snapshot = yield* Ref.get(snapshotRef)
		const compaction = yield* compactSnapshot(snapshot, turnId, modelGateway, abortSignal)
		if (!compaction) return snapshot
		const persisted = yield* store.appendEntries(snapshot, [compaction.entry])
		yield* Ref.set(snapshotRef, persisted)
		return persisted
	})

	const prompt = Effect.fn("AgentHarness.prompt")(
		function* <TOOLS extends ToolSet>({
			text,
			turnId,
			system,
			tools,
			abortSignal,
			onFinish,
		}: AgentPromptInput & {
			tools: TOOLS
			onFinish?: StreamTextOnFinishCallback<TOOLS>
		}) {
			const loaded = yield* loadSnapshot
			const snapshotAfterCompaction = yield* compactNow(turnId, abortSignal)
			const userNow = yield* Clock.currentTimeMillis
			const userEntries = appendUserMessage(snapshotAfterCompaction, turnId, text, userNow)
			const withUser = yield* store.appendEntries(snapshotAfterCompaction, userEntries, {
				nextTurnIndex: snapshotAfterCompaction.nextTurnIndex + 1,
			})
			yield* Ref.set(snapshotRef, withUser)

			const controller = new AbortController()
			if (abortSignal) {
				abortSignal.addEventListener("abort", () => controller.abort(), { once: true })
			}
			yield* Ref.set(activeAbortRef, controller)

			const result = modelGateway.streamTurn({
				system,
				messages: buildSessionContext(withUser),
				tools,
				abortSignal: controller.signal,
				onFinish,
			})

			// Persist the model's response once the stream finishes. Detached from
			// the calling fiber so the caller can return `result` immediately and
			// stream it; the persistence outlives this prompt call.
			yield* Effect.forkDetach(
				Effect.gen(function* () {
					const steps = yield* Effect.tryPromise(() => Promise.resolve(result.steps))
					const finalStep = steps[steps.length - 1]
					if (finalStep) {
						const responseNow = yield* Clock.currentTimeMillis
						const responseEntries = toResponseEntries(
							sessionId,
							turnId,
							finalStep.response.messages as ReadonlyArray<ModelMessage>,
							responseNow,
						)
						const usage = toSessionUsage(
							finalStep.usage,
							responseEntries.at(-1)?.id ?? `${sessionId}:${turnId}:usage`,
						)
						const nextSnapshot = yield* store.appendEntries(withUser, responseEntries, {
							lastSuccessfulUsage: usage,
						})
						yield* Ref.set(snapshotRef, nextSnapshot)
					}
				}).pipe(
					// Best-effort persistence: swallow stream/store failures so a
					// failed background persist never crashes the runtime fiber.
					Effect.ignore,
					Effect.ensuring(Ref.set(activeAbortRef, undefined)),
				),
			)

			return { result, snapshot: loaded }
		},
		// Preserve the originating error as the `cause` instead of stringifying it,
		// so store/model/compaction failures keep their tag + context for debugging.
		Effect.mapError((error: AgentHarnessError) =>
			error._tag === "@maple/agent-harness/ModelError"
				? error
				: new AgentHarnessModelError({
						message: error.message,
						cause: error,
					}),
		),
	)

	return {
		state: Ref.get(snapshotRef),
		compactNow,
		prompt,
		continue: (text: string) => enqueueCommand(commandQueue, "continue", text),
		steer: (text: string) => enqueueCommand(commandQueue, "steer", text),
		followUp: (text: string) => enqueueCommand(commandQueue, "follow_up", text),
		abort: () =>
			Ref.get(activeAbortRef).pipe(
				Effect.flatMap((controller) => Effect.sync(() => controller?.abort())),
			),
	} satisfies AgentHarnessRuntime
})
