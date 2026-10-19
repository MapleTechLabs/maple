import type { Message } from "@cloudflare/workers-types"
import { assert, describe, it } from "@effect/vitest"
import { VcsRateLimitedError } from "@maple/domain/http"
import {
	VcsSyncService,
	type VcsSyncServiceApi,
} from "@maple/backend/services/integrations/vcs/VcsSyncService"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { processBatch, processPlacedBatch } from "../vcs-sync-runtime"
import { handOffVcsSyncBatch, serveVcsSyncBatch } from "./vcs-sync"
import {
	type MessageOutcome,
	type PlacedMessage,
	SELF_BINDING,
	VCS_SYNC_BATCH_PATH,
} from "./vcs-sync-dispatch"

const TOKEN = "secret-token"
const ENV = { INTERNAL_SERVICE_TOKEN: TOKEN }

const Job = Schema.Struct({ kind: Schema.Literals(["ok", "rate-limited", "broken"]) })

/** A sync service whose jobs succeed, hit a rate limit, or fail; it records exhausted ones. */
const syncService = (exhausted: Array<unknown>) =>
	Layer.succeed(VcsSyncService, {
		processMessage: (raw) =>
			Schema.decodeUnknownEffect(Job)(raw).pipe(
				Effect.orDie,
				Effect.flatMap(({ kind }) =>
					kind === "ok"
						? Effect.void
						: kind === "rate-limited"
							? Effect.fail(
									new VcsRateLimitedError({ message: "slow down", retryAfterSeconds: 120 }),
								)
							: Effect.die("broken job"),
				),
			),
		recordExhaustedFailure: (raw) => Effect.sync(() => exhausted.push(raw)),
	} satisfies VcsSyncServiceApi)

/** A delivered message that records what the consumer decided for it. */
const message = (id: string, kind: string, settled: Array<string>, attempts = 1): Message<unknown> => ({
	id,
	timestamp: new Date(0),
	body: { kind },
	attempts,
	ack: () => settled.push(`${id}:ack`),
	retry: (options) =>
		settled.push(
			options?.delaySeconds === undefined ? `${id}:retry` : `${id}:retry:${options.delaySeconds}`,
		),
})

type Run = (
	messages: ReadonlyArray<PlacedMessage>,
	placement: string,
) => Effect.Effect<ReadonlyArray<MessageOutcome>, unknown>

/** The self binding, answering through the real route handler over `run`. */
const selfBinding = (handlerEnv: Record<string, unknown>, run: Run, seen: Array<Request> = []) => ({
	fetch: (input: RequestInfo, init?: RequestInit) => {
		const request = new Request(input, init)
		seen.push(request.clone())
		return Effect.runPromise(
			serveVcsSyncBatch(handlerEnv, run).pipe(
				Effect.map((response) => HttpServerResponse.toWeb(response)),
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(request),
				),
			),
		)
	},
})

const placedRun =
	(exhausted: Array<unknown>): Run =>
	(messages, placement) =>
		processPlacedBatch(messages, placement).pipe(Effect.provide(syncService(exhausted)))

describe("VCS sync batches over the self binding", () => {
	it.effect("runs the batch in the placed handler and applies each message's outcome", () =>
		Effect.gen(function* () {
			const settled: Array<string> = []
			const exhausted: Array<unknown> = []
			const seen: Array<Request> = []
			const env = { ...ENV, [SELF_BINDING]: selfBinding(ENV, placedRun(exhausted), seen) }
			const inline = yield* handOffVcsSyncBatch(env, [
				message("a", "ok", settled),
				message("b", "rate-limited", settled),
				message("c", "broken", settled, 4),
				message("d", "broken", settled),
			])
			assert.isFalse(inline)
			assert.deepStrictEqual(settled, ["a:ack", "b:retry:120", "c:ack", "d:retry"])
			assert.deepStrictEqual(exhausted, [{ kind: "broken" }])
			assert.strictEqual(new URL(seen[0]!.url).pathname, VCS_SYNC_BATCH_PATH)
			assert.strictEqual(seen[0]!.headers.get("authorization"), `Bearer ${TOKEN}`)
		}),
	)

	it.effect("leaves the batch to run inline when the binding is missing or refuses it", () =>
		Effect.gen(function* () {
			const settled: Array<string> = []
			const batch = [message("a", "ok", settled)]
			assert.isTrue(yield* handOffVcsSyncBatch(ENV, batch))
			// The handler holds a different token: a 401, so nothing ran there.
			const refusing = selfBinding({ INTERNAL_SERVICE_TOKEN: "other" }, placedRun([]))
			assert.isTrue(yield* handOffVcsSyncBatch({ ...ENV, [SELF_BINDING]: refusing }, batch))
			assert.deepStrictEqual(settled, [])
		}),
	)

	it.effect("retries every message when the placed run fails, and never acks one without an outcome", () =>
		Effect.gen(function* () {
			const settled: Array<string> = []
			const failing = selfBinding(ENV, () => Effect.fail("pool exhausted"))
			const failed = yield* handOffVcsSyncBatch({ ...ENV, [SELF_BINDING]: failing }, [
				message("a", "ok", settled),
				message("b", "ok", settled),
			])
			assert.isFalse(failed)
			assert.deepStrictEqual(settled, ["a:retry", "b:retry"])

			settled.length = 0
			const partial = selfBinding(ENV, () => Effect.succeed([{ id: "a", outcome: "ack" as const }]))
			yield* handOffVcsSyncBatch({ ...ENV, [SELF_BINDING]: partial }, [
				message("a", "ok", settled),
				message("b", "ok", settled),
			])
			assert.deepStrictEqual(settled, ["a:ack", "b:retry"])
		}),
	)

	it.effect("inline, settles each message as it finishes, the same way", () =>
		Effect.gen(function* () {
			const settled: Array<string> = []
			yield* processBatch({
				messages: [message("a", "ok", settled), message("b", "rate-limited", settled)],
			}).pipe(Effect.provide(syncService([])))
			assert.deepStrictEqual(settled, ["a:ack", "b:retry:120"])
		}),
	)
})
