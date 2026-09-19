import { assert, describe, it } from "@effect/vitest"
import { createMaplePgPool, type MapleDb, type MaplePgPool, type MaplePgPoolOptions } from "@maple/db/client"
import { sql } from "drizzle-orm"
import { Effect, Exit, Fiber, Option, References, Schema, Tracer } from "effect"
import { createServer, type Socket } from "node:net"
import { MapleDbConnection } from "./bindings"
import {
	executeOnFreshPgClient,
	makePgConnectionScope,
	PgConnectionScope,
	type PgConnectionScopeApi,
	PgConnectionScopeClosedError,
	pgConnectionScopeFrom,
	withPgConnectionScope,
	withPgConnectionScopeOf,
} from "./pg-connection-scope"

/**
 * A pool that never touches the network.
 *
 * A real node-postgres pool, because the drizzle database is built over it —
 * constructing one connects to nothing (the pool dials on the first statement),
 * and these tests never issue one, so the port below is never reached.
 */
const fakePool = (onEnd: () => void): MaplePgPool => {
	const pool = createMaplePgPool("postgres://maple:maple@127.0.0.1:1/never", { maxConnections: 1 })
	const end = pool.end.bind(pool)
	pool.end = () => {
		onEnd()
		return end()
	}
	return pool
}

interface Recorder {
	readonly openPool: (options: MaplePgPoolOptions) => MaplePgPool
	readonly creations: () => number
	readonly ends: () => number
	readonly lastOptions: () => MaplePgPoolOptions | undefined
}

const recorder = (): Recorder => {
	let creations = 0
	let ends = 0
	let lastOptions: MaplePgPoolOptions | undefined
	return {
		creations: () => creations,
		ends: () => ends,
		lastOptions: () => lastOptions,
		openPool: (options) => {
			creations += 1
			lastOptions = options
			return fakePool(() => {
				ends += 1
			})
		},
	}
}

const noop = () => Effect.succeed("ok")

class CallbackFailure extends Schema.TaggedError<CallbackFailure>()("@maple/test/CallbackFailure", {
	message: Schema.String,
}) {}
const boom = () => Effect.fail(new CallbackFailure({ message: "boom" }))

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

const dbSpans = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
	spans.filter((span) => span.attributes.get("db.system.name") === "postgresql")

describe("PgConnectionScope", () => {
	it.effect("creates one pool and reuses it across every execute", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			yield* scope.run(noop)
			yield* scope.run(noop)
			yield* scope.run(noop)

			// The whole point: these used to be three connections.
			assert.strictEqual(rec.creations(), 1)
			yield* scope.close
			assert.strictEqual(rec.ends(), 1)
		}),
	)

	it.effect("creates nothing for a scope that never touches the database", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			yield* scope.close

			assert.strictEqual(rec.creations(), 0)
			assert.strictEqual(rec.ends(), 0)
		}),
	)

	it.effect("shares one database across executes; statement capture is per call", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})
			const clients: Array<MapleDb> = []
			const capture = (db: MapleDb) => {
				clients.push(db)
				return Effect.succeed("ok")
			}

			yield* Effect.all([scope.run(capture), scope.run(capture)], { concurrency: 2 })

			// One pool, one database. The per-call statement collector is a fiber
			// reference, so sharing the database cannot cross-attribute SQL.
			assert.strictEqual(rec.creations(), 1)
			assert.strictEqual(clients.length, 2)
			assert.strictEqual(clients[0], clients[1])
			yield* scope.close
		}),
	)

	it.effect("reports reuse on the span", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const { spans, tracer } = makeRecordingTracer()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			yield* scope.run(noop).pipe(Effect.withTracer(tracer))
			yield* scope.run(noop).pipe(Effect.withTracer(tracer))

			const [first, second] = dbSpans(spans)
			assert.isDefined(first)
			assert.isDefined(second)
			assert.strictEqual(first.attributes.get("db.connect.reused"), false)
			assert.strictEqual(second.attributes.get("db.connect.reused"), true)
			yield* scope.close
		}),
	)

	it.effect("carries the connection-source attributes onto every span", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const { spans, tracer } = makeRecordingTracer()
			const scope = makePgConnectionScope(
				"postgres://unused",
				{ "db.namespace": "maple", "server.address": "cfg.hyperdrive.local" },
				{ openPool: rec.openPool },
			)

			yield* scope.run(noop).pipe(Effect.withTracer(tracer))

			const [span] = dbSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("db.namespace"), "maple")
			assert.strictEqual(span.attributes.get("server.address"), "cfg.hyperdrive.local")
			yield* scope.close
		}),
	)

	it.effect("surfaces a failing call without swallowing it", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			// With no probe there is no separate connect phase: a connection problem
			// arrives as the statement's own error, which is what `postgres-errors`
			// classifies. Here the callback itself fails; the pool was still opened
			// for it.
			const exit = yield* Effect.exit(scope.run(boom))

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(rec.creations(), 1)
			yield* scope.close
		}),
	)

	it.effect("opens the pool at Cloudflare's ceiling rather than serializing on one connection", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			yield* scope.run(noop)

			// This was 1 for one day and serialized every statement in a cron tick
			// behind a single connection — `SELECT actors` p50 928ms -> 5687ms at flat
			// volume. `max` is a ceiling, not a reservation.
			assert.strictEqual(rec.lastOptions()?.maxConnections, 5)
			yield* scope.close
		}),
	)

	it.effect("bounds the dial so a stall is classifiable instead of unbounded", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			yield* scope.run(noop)

			// Unset, a stalled dial hangs for the whole invocation and lands with no
			// error.type at all.
			const connectTimeoutSeconds = rec.lastOptions()?.connectTimeoutSeconds
			assert.isDefined(connectTimeoutSeconds)
			assert.isAbove(connectTimeoutSeconds, 0)
			yield* scope.close
		}),
	)

	it.effect("closes twice without opening a second connection", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			yield* scope.run(noop)
			yield* scope.close
			yield* scope.close

			assert.strictEqual(rec.creations(), 1)
			assert.strictEqual(rec.ends(), 1)
		}),
	)

	it.effect("refuses a call that arrives after the scope closed instead of dialing again", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const { spans, tracer } = makeRecordingTracer()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			yield* scope.run(noop)
			yield* scope.close

			// The bug this replaces: `close` set the handle back to `undefined`, which
			// is also what "never dialed" looked like, so this call opened a second
			// socket after the invocation that owned it had ended — on Workers, past
			// the point where one may exist at all. Late work is a defect to report,
			// not a connection to open.
			const exit = yield* Effect.exit(scope.run(noop).pipe(Effect.withTracer(tracer)))

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(rec.creations(), 1)
			assert.strictEqual(rec.ends(), 1)
			const [span] = dbSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("db.connect.scope_state"), "closed")
			// Not a driver fault, so it must not land as an unlabelled database
			// error beside real ones.
			assert.strictEqual(span.attributes.get("error.type"), "SCOPE_CLOSED")
		}),
	)

	it.effect("keeps the closed-scope failure discriminable behind the DatabaseError channel", () =>
		Effect.gen(function* () {
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: recorder().openPool,
			})

			yield* scope.close
			const error = yield* Effect.flip(scope.run(noop))

			// `run` stays typed as DatabaseError — ~200 call sites depend on that —
			// but the reason travels as a tagged cause instead of flattened prose.
			assert.strictEqual(error._tag, "@maple/api/lib/DatabaseError")
			assert.instanceOf(error.cause, PgConnectionScopeClosedError)
		}),
	)

	it.effect("refuses a first call after close without ever creating a connection", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			yield* scope.close
			const exit = yield* Effect.exit(scope.run(noop))

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(rec.creations(), 0)
		}),
	)

	it.effect("closes an in-flight connection and refuses the calls that follow it", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openPool: rec.openPool,
			})

			// Close transitions to Closed before releasing, so a caller racing the
			// teardown is refused rather than handed a pool being ended underneath it.
			const running = yield* Effect.forkChild(scope.run(() => Effect.never))
			yield* Effect.yieldNow
			yield* scope.close
			yield* Fiber.interrupt(running)

			const exit = yield* Effect.exit(scope.run(noop))

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(rec.creations(), 1)
			assert.strictEqual(rec.ends(), 1)
		}),
	)

	it.live("labels a call refused by a close that landed while it waited for the gate", () =>
		Effect.gen(function* () {
			// The window: `run` passes its synchronous Closed check while the scope is
			// Cold, yields before taking the gate, and `close` gets there first. A
			// small scheduler op budget forces that interleaving deterministically;
			// the sweep keeps the test independent of how many ops each step costs.
			// It starts at 3: at 1 or 2 even a bare `Effect.forEach` never completes.
			let raced = 0
			for (let budget = 3; budget <= 48; budget++) {
				const { spans, tracer } = makeRecordingTracer()
				const scope = makePgConnectionScope("postgres://unused", undefined, {
					openPool: recorder().openPool,
				})
				const running = yield* Effect.forkChild(
					scope
						.run(noop)
						.pipe(
							Effect.withTracer(tracer),
							Effect.provideService(References.MaxOpsBeforeYield, budget),
						),
				)
				const closing = yield* Effect.forkChild(scope.close)
				const exit = yield* Fiber.await(running)
				yield* Fiber.join(closing)

				const [span] = dbSpans(spans)
				// `db.connect.reused` is recorded only past the synchronous check.
				if (!Exit.isFailure(exit) || span?.attributes.get("db.connect.reused") === undefined) continue
				raced += 1
				assert.strictEqual(span.attributes.get("error.type"), "SCOPE_CLOSED", `budget ${budget}`)
				assert.strictEqual(
					span.attributes.get("db.connect.scope_state"),
					"closed",
					`budget ${budget}`,
				)
			}
			assert.isAbove(raced, 0, "no op budget reproduced the close-while-waiting interleaving")
		}),
	)
})

/**
 * A local TCP server standing in for a Hyperdrive origin that misbehaves:
 * `stall` accepts and never answers the startup message, `hangup` accepts and
 * drops the socket. node-postgres reports both with no `code`, which is the
 * shape `@effect/sql-pg` classifies as `UnknownError`.
 */
const misbehavingServer = (behaviour: "stall" | "hangup") =>
	Effect.acquireRelease(
		Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
			const sockets = new Set<Socket>()
			const server = createServer((socket) => {
				sockets.add(socket)
				if (behaviour === "hangup") socket.once("data", () => socket.destroy())
			})
			server.listen(0, "127.0.0.1", () => {
				const address = server.address()
				const port = typeof address === "object" && address !== null ? address.port : 0
				resume(
					Effect.succeed({
						url: `postgres://maple:maple@127.0.0.1:${port}/maple`,
						close: () => {
							for (const socket of sockets) socket.destroy()
							server.close()
						},
					}),
				)
			})
		}),
		(server) => Effect.sync(server.close),
	)

const failedDbSpan = (behaviour: "stall" | "hangup") =>
	Effect.gen(function* () {
		const server = yield* misbehavingServer(behaviour)
		const { spans, tracer } = makeRecordingTracer()
		const scope = makePgConnectionScope(server.url, undefined, {
			// The production factory, with the dial bound shortened for the test.
			openPool: (options) => createMaplePgPool(server.url, { ...options, connectTimeoutSeconds: 0.3 }),
		})
		const exit = yield* Effect.exit(
			withPgConnectionScopeOf(
				scope,
				scope.run((db) => db.execute(sql`select 1`)).pipe(Effect.withTracer(tracer)),
			),
		)
		assert.isTrue(Exit.isFailure(exit))
		const [span] = dbSpans(spans)
		assert.isDefined(span)
		return span
	}).pipe(Effect.scoped)

describe("connection failures through the real driver", () => {
	it.live("classifies a dial that hits the connect timeout as a connection failure", () =>
		Effect.gen(function* () {
			const span = yield* failedDbSpan("stall")
			assert.strictEqual(span.attributes.get("error.type"), "ConnectionError")
			assert.strictEqual(span.attributes.get("db.connect.failed"), true)
			assert.isUndefined(span.attributes.get("db.response.status_code"))
		}),
	)

	it.live("classifies a socket the server drops as a connection failure", () =>
		Effect.gen(function* () {
			const span = yield* failedDbSpan("hangup")
			assert.strictEqual(span.attributes.get("error.type"), "ConnectionError")
			assert.strictEqual(span.attributes.get("db.connect.failed"), true)
		}),
	)
})

describe("executeOnFreshPgClient", () => {
	it.effect("runs the callback and releases its connection", () =>
		Effect.gen(function* () {
			// No seam: this builds a real pool, which connects lazily. Nothing here
			// issues a statement, so the unroutable port is never dialed.
			const result = yield* executeOnFreshPgClient("postgres://maple:maple@127.0.0.1:1/never", noop)

			assert.strictEqual(result, "ok")
		}),
	)

	it.effect("releases its connection when the callback fails, and preserves the error", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				executeOnFreshPgClient("postgres://maple:maple@127.0.0.1:1/never", boom),
			)

			assert.isTrue(Exit.isFailure(exit))
		}),
	)
})

describe("pgConnectionScopeFrom", () => {
	it.effect("spans a database someone else owns and never closes it", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const rec = recorder()
			// Build a real database the way the Workflow seams do, without dialing.
			const owning = makePgConnectionScope("postgres://unused", undefined, { openPool: rec.openPool })
			const owned = yield* owning.run((db) => Effect.succeed(db))
			const scope = pgConnectionScopeFrom(owned)

			const seen: Array<MapleDb> = []
			const result = yield* scope
				.run((db) => {
					seen.push(db)
					return Effect.succeed("ok")
				})
				.pipe(Effect.withTracer(tracer))
			yield* scope.close

			assert.strictEqual(result, "ok")
			assert.strictEqual(seen[0], owned)
			assert.strictEqual(dbSpans(spans).length, 1)
			// The caller owns the connection; closing it here would pull it out from
			// under the Workflow that handed it over.
			assert.strictEqual(rec.ends(), 0)
			yield* owning.close
		}),
	)
})

/** A scope that records release without opening anything. */
const countingScope = () => {
	let closes = 0
	const scope: PgConnectionScopeApi = {
		run: () => Effect.succeed("unused" as never),
		close: Effect.sync(() => {
			closes += 1
		}),
	}
	return { scope, closes: () => closes }
}

describe("withPgConnectionScopeOf", () => {
	it.effect("releases the connection when the program succeeds", () =>
		Effect.gen(function* () {
			const { scope, closes } = countingScope()

			const result = yield* withPgConnectionScopeOf(scope, Effect.succeed("done"))

			assert.strictEqual(result, "done")
			assert.strictEqual(closes(), 1)
		}),
	)

	it.effect("releases the connection when the program fails, and preserves the error", () =>
		Effect.gen(function* () {
			const { scope, closes } = countingScope()

			const exit = yield* Effect.exit(withPgConnectionScopeOf(scope, Effect.fail("boom")))

			// A leak here is the worst case: the request is over, but its connection
			// is still holding one of the Worker's six outbound slots.
			assert.strictEqual(closes(), 1)
			assert.isTrue(Exit.isFailure(exit))
		}),
	)

	it.effect("releases the connection when the program is interrupted", () =>
		Effect.gen(function* () {
			const { scope, closes } = countingScope()
			const fiber = yield* Effect.forkChild(withPgConnectionScopeOf(scope, Effect.never))

			yield* Effect.yieldNow
			yield* Fiber.interrupt(fiber)

			assert.strictEqual(closes(), 1)
		}),
	)

	it.effect("makes the scope visible to code inside and invisible outside", () =>
		Effect.gen(function* () {
			const { scope } = countingScope()

			const inside = yield* withPgConnectionScopeOf(scope, PgConnectionScope)
			const outside = yield* PgConnectionScope

			assert.strictEqual(inside, scope)
			assert.isUndefined(outside)
		}),
	)
})

describe("withPgConnectionScope", () => {
	const hyperdrive = Option.some({
		connectionString: "postgres://maple:maple@cfg.hyperdrive.local:5432/maple",
		attributes: {
			"db.namespace": "maple",
			"server.address": "cfg.hyperdrive.local",
			"server.port": 5432,
		},
	})

	it.effect("installs a scope when the MAPLE_DB binding is present", () =>
		Effect.gen(function* () {
			const scope = yield* withPgConnectionScope(PgConnectionScope).pipe(
				Effect.provideService(MapleDbConnection, hyperdrive),
			)

			// Lazy: resolving the binding must not connect. Nothing here reaches the
			// network, and the host above does not resolve.
			assert.isDefined(scope)
		}),
	)

	it.effect("runs unwrapped on a stage with no application database", () =>
		Effect.gen(function* () {
			// PR previews bind no MAPLE_DB. Installing a scope here would have to
			// invent a connection string; instead the program runs without one and
			// DatabasePgLive keeps reporting the missing binding per execute, so
			// DB-free routes still serve.
			const scope = yield* withPgConnectionScope(PgConnectionScope).pipe(
				Effect.provideService(MapleDbConnection, Option.none()),
			)

			assert.isUndefined(scope)
		}),
	)
})
