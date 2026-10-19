import type { Message } from "@cloudflare/workers-types"
import { assert, describe, it } from "@effect/vitest"
import { VcsRateLimitedError } from "@maple/domain/http"
import {
	VcsSyncService,
	type VcsSyncServiceApi,
} from "@maple/backend/services/integrations/vcs/VcsSyncService"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { processBatch, processPlacedBatch, recordExhaustedBatch } from "../vcs-sync-runtime"
import { handOffVcsSyncBatch, serveVcsSyncBatch } from "./vcs-sync"
import {
	type MessageOutcome,
	type PlacedMessage,
	SELF_BINDING,
	VCS_SYNC_BATCH_MAX_BYTES,
	VCS_SYNC_BATCH_PATH,
	VCS_SYNC_BATCH_SIZE,
	VCS_SYNC_HOP_SECRET,
} from "./vcs-sync-dispatch"

const TOKEN = "hop-secret"
const INTERNAL_TOKEN = "internal-token"
// The Worker holds both; only the hop secret opens the route.
const ENV = { [VCS_SYNC_HOP_SECRET]: TOKEN, INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN }

// The route takes only real jobs; the installation id says how the fake service treats one.
const Job = Schema.Struct({ externalInstallationId: Schema.Literals(["ok", "rate-limited", "broken"]) })
const job = (kind: string) => ({
	kind: "installation-sync",
	provider: "github",
	externalInstallationId: kind,
	reason: "created",
})

/** A sync service whose jobs succeed, hit a rate limit, or fail; it records exhausted ones. */
const syncService = (exhausted: Array<unknown>) =>
	Layer.succeed(VcsSyncService, {
		processMessage: (raw) =>
			Schema.decodeUnknownEffect(Job)(raw).pipe(
				Effect.orDie,
				Effect.flatMap(({ externalInstallationId: kind }) =>
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
	body: job(kind),
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
			const handOff = yield* handOffVcsSyncBatch(env, [
				message("a", "ok", settled),
				message("b", "rate-limited", settled),
				message("c", "broken", settled, 4),
				message("d", "broken", settled),
			])
			assert.deepStrictEqual(handOff, { run: "placed" })
			assert.deepStrictEqual(settled, ["a:ack", "b:retry:120", "c:ack", "d:retry"])
			assert.deepStrictEqual(exhausted, [job("broken")])
			assert.strictEqual(new URL(seen[0]!.url).pathname, VCS_SYNC_BATCH_PATH)
			assert.strictEqual(seen[0]!.headers.get("authorization"), `Bearer ${TOKEN}`)
		}),
	)

	it.effect("leaves the batch to run inline when the binding is missing or refuses it", () =>
		Effect.gen(function* () {
			const settled: Array<string> = []
			const batch = [message("a", "ok", settled)]
			assert.deepStrictEqual(yield* handOffVcsSyncBatch(ENV, batch), { run: "inline" })
			// The handler holds a different secret: a 401, so nothing ran there.
			const refusing = selfBinding({ ...ENV, [VCS_SYNC_HOP_SECRET]: "other" }, placedRun([]))
			assert.deepStrictEqual(yield* handOffVcsSyncBatch({ ...ENV, [SELF_BINDING]: refusing }, batch), {
				run: "inline",
			})
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
			assert.deepStrictEqual(failed, { run: "exhausted", messages: [] })
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

	it.effect("records the terminal status of a final delivery whose placed run failed, and acks it", () =>
		Effect.gen(function* () {
			const settled: Array<string> = []
			const exhausted: Array<unknown> = []
			const failing = selfBinding(ENV, () => Effect.fail("pool exhausted"))
			const handOff = yield* handOffVcsSyncBatch({ ...ENV, [SELF_BINDING]: failing }, [
				message("a", "ok", settled),
				message("c", "ok", settled, 4),
			])
			// The retry goes out at once; the final delivery waits for its terminal record.
			assert.deepStrictEqual(settled, ["a:retry"])
			assert.strictEqual(handOff.run, "exhausted")
			if (handOff.run !== "exhausted") return
			yield* recordExhaustedBatch(handOff.messages).pipe(Effect.provide(syncService(exhausted)))
			assert.deepStrictEqual(settled, ["a:retry", "c:ack"])
			assert.deepStrictEqual(exhausted, [job("ok")])
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

describe("the VCS sync batch route", () => {
	/** Serves one request through the real route; the run records that it was reached. */
	const serve = (headers: Record<string, string>, body: string) =>
		Effect.gen(function* () {
			const ran: Array<number> = []
			const request = new Request(`https://api.example${VCS_SYNC_BATCH_PATH}`, {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, ...headers },
				body,
			})
			const response = yield* serveVcsSyncBatch(ENV, (messages) =>
				Effect.sync(() => ran.push(messages.length)).pipe(Effect.as([])),
			).pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(request),
				),
			)
			return { status: HttpServerResponse.toWeb(response).status, ran }
		})
	const batchOf = (count: number) =>
		JSON.stringify({
			messages: Array.from({ length: count }, (_, i) => ({
				id: `m${i}`,
				body: job("ok"),
				attempts: 1,
			})),
		})

	it.effect("serves a full queue batch of real jobs", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* serve({}, batchOf(VCS_SYNC_BATCH_SIZE)), { status: 200, ran: [10] })
		}),
	)

	it.effect("refuses the internal service token, which other Workers hold", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* serve({ authorization: `Bearer ${INTERNAL_TOKEN}` }, batchOf(1)), {
				status: 401,
				ran: [],
			})
		}),
	)

	it.effect("answers 404 to a request from the internet, even with the bearer", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* serve({ "cf-connecting-ip": "203.0.113.7" }, batchOf(1)), {
				status: 404,
				ran: [],
			})
		}),
	)

	it.effect("refuses more messages than a queue batch, bodies that are not jobs, and oversize bodies", () =>
		Effect.gen(function* () {
			const refused = { status: 400, ran: [] }
			assert.deepStrictEqual(yield* serve({}, batchOf(VCS_SYNC_BATCH_SIZE + 1)), refused)
			const notAJob = JSON.stringify({
				messages: [{ id: "m", body: { kind: "drop-tables" }, attempts: 1 }],
			})
			assert.deepStrictEqual(yield* serve({}, notAJob), refused)
			// No content-length on this request: the bounded read is what refuses it.
			const oversize = JSON.stringify({ messages: [], pad: "x".repeat(VCS_SYNC_BATCH_MAX_BYTES) })
			assert.deepStrictEqual(yield* serve({}, oversize), refused)
			assert.deepStrictEqual(
				yield* serve({ "content-length": String(VCS_SYNC_BATCH_MAX_BYTES + 1) }, "{}"),
				refused,
			)
		}),
	)

	it.effect("a binding call refused as public still runs the batch inline", () =>
		Effect.gen(function* () {
			const settled: Array<string> = []
			const stamped = {
				fetch: (input: RequestInfo, init?: RequestInit) => {
					const request = new Request(input, init)
					request.headers.set("cf-connecting-ip", "203.0.113.7")
					return selfBinding(ENV, placedRun([])).fetch(request)
				},
			}
			const handOff = yield* handOffVcsSyncBatch({ ...ENV, [SELF_BINDING]: stamped }, [
				message("a", "ok", settled),
			])
			assert.deepStrictEqual(handOff, { run: "inline" })
			assert.deepStrictEqual(settled, [])
		}),
	)
})
