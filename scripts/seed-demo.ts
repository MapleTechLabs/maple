#!/usr/bin/env bun
/**
 * `bun run seed:demo`: fill the local stack with the Acme Shop world (see
 * `seed-demo/scenario.ts`) for landing screenshots and UI checks.
 *
 * Telemetry goes through the local ingest gateway like real traffic, so it
 * lands in the org `MAPLE_ORG_ID_OVERRIDE` names. The run's time anchor is
 * written to `seed-demo/.last-seed.json`; screenshots pin their time ranges to it.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schedule from "effect/Schedule"
import { resourceLogs, resourceMetrics, resourceSpans } from "./seed-demo/otlp"
import { Rng } from "./seed-demo/rng"
import { generateWindow, World, type Grouped, type WindowOutput } from "./seed-demo/telemetry"

const HOUR = 3_600_000
const MINUTE = 60_000
const SPANS_PER_REQUEST = 2_000
const STATE_FILE = new URL("./seed-demo/.last-seed.json", import.meta.url).pathname

class SeedPreflightError extends Schema.TaggedError<SeedPreflightError>()("@maple/seed-demo/PreflightError", {
	message: Schema.String,
}) {}

const SeedState = Schema.Struct({
	anchor: Schema.DateTimeUtcFromString,
	start: Schema.DateTimeUtcFromString,
	incidentAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
	seed: Schema.optionalKey(Schema.Number),
	followedThrough: Schema.optionalKey(Schema.DateTimeUtcFromString),
})

class SeedIngestError extends Schema.TaggedError<SeedIngestError>()("@maple/seed-demo/IngestError", {
	message: Schema.String,
	path: Schema.String,
}) {}

interface Target {
	readonly endpoint: string
	readonly key: string
}

const env = (name: string) => Option.fromNullishOr(process.env[name]?.trim() || undefined)

// ── preflight ───────────────────────────────────────────────────────────────

const checkIngest = Effect.fn("seedDemo.checkIngest")(function* (target: Target) {
	const client = yield* HttpClient.HttpClient
	const response = yield* client.execute(HttpClientRequest.get(`${target.endpoint}/health`)).pipe(
		Effect.mapError(
			() =>
				new SeedPreflightError({
					message: `the ingest gateway is not answering at ${target.endpoint}. Start it with \`bun dev ingest\`.`,
				}),
		),
	)
	if (response.status !== 200) {
		return yield* new SeedPreflightError({
			message: `the ingest gateway at ${target.endpoint}/health answered ${response.status}`,
		})
	}
})

/** A BYO ClickHouse row makes seeded data invisible and puts that warehouse's data in the shots. */
const checkWarehouseRouting = Effect.fn("seedDemo.checkWarehouseRouting")(function* (orgId: string) {
	const pgUrl = env("MAPLE_PG_URL")
	if (Option.isNone(pgUrl) || !/^org_[A-Za-z0-9]+$/.test(orgId)) {
		yield* Console.warn("  ! skipped the BYO ClickHouse check (no MAPLE_PG_URL, or an unexpected org id)")
		return
	}
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const output = yield* spawner
		.string(
			ChildProcess.make("psql", [
				pgUrl.value,
				"-tAc",
				`SELECT ch_url FROM org_clickhouse_settings WHERE org_id = '${orgId}'`,
			]),
		)
		.pipe(Effect.option)
	if (Option.isNone(output)) {
		yield* Console.warn("  ! could not run psql; skipped the BYO ClickHouse check")
		return
	}
	const chUrl = output.value.trim()
	if (chUrl !== "") {
		return yield* new SeedPreflightError({
			message:
				`org ${orgId} reads from its own ClickHouse (${chUrl}), so seeded data would be invisible and ` +
				"screenshots would show that warehouse instead. Remove it with DELETE /api/org-clickhouse-settings/ " +
				"(not raw SQL: the config is edge-cached for an hour) and re-run.",
		})
	}
})

const checkWarehouse = Effect.fn("seedDemo.checkWarehouse")(function* () {
	const host = env("TINYBIRD_HOST")
	if (Option.isNone(host)) return
	const client = yield* HttpClient.HttpClient
	const reachable = yield* client.execute(HttpClientRequest.get(host.value)).pipe(Effect.option)
	if (Option.isNone(reachable)) {
		yield* Console.warn(
			`  ! TINYBIRD_HOST (${host.value}) is not answering. Ingest will accept the data, but nothing lands until it is up.`,
		)
	}
})

// ── reset ───────────────────────────────────────────────────────────────────

const ERROR_STATE_TABLES = [
	"error_fingerprint_candidates",
	"error_incidents",
	"error_issue_events",
	"error_issue_pull_requests",
	"error_issue_states",
	"error_issue_verifications",
	"error_issues",
	"error_notification_deliveries",
	"investigations",
]

const Datasources = Schema.Struct({ datasources: Schema.Array(Schema.Struct({ name: Schema.String })) })

/**
 * `--reset`: start the demo world over, so a re-seed never doubles rows. Only
 * ever touches a localhost warehouse and the `maple_screenshots` database. The
 * error tick's watermark is set just before the incident: on first sight it
 * would otherwise bootstrap to "now" and skip the seeded history.
 */
const resetDemo = Effect.fn("seedDemo.reset")(function* (orgId: string, incidentAt: number) {
	const host = env("TINYBIRD_HOST")
	const token = env("TINYBIRD_TOKEN")
	const pgUrl = env("MAPLE_PG_URL")
	if (Option.isNone(host) || Option.isNone(token) || Option.isNone(pgUrl)) {
		return yield* new SeedPreflightError({
			message: "--reset needs TINYBIRD_HOST, TINYBIRD_TOKEN and MAPLE_PG_URL",
		})
	}
	if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(host.value)) {
		return yield* new SeedPreflightError({
			message: `--reset only truncates a local warehouse, not ${host.value}`,
		})
	}
	if (
		!/^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)(:\d+)?\/maple_screenshots(\?|$)/.test(
			pgUrl.value,
		) ||
		!/^org_[A-Za-z0-9]+$/.test(orgId)
	) {
		return yield* new SeedPreflightError({
			message: "--reset only runs against a local maple_screenshots database (bun run seed:demo:env)",
		})
	}

	const client = (yield* HttpClient.HttpClient).pipe(
		HttpClient.mapRequest(HttpClientRequest.bearerToken(token.value)),
		HttpClient.filterStatusOk,
	)
	const fail = (cause: { readonly message: string }) =>
		new SeedPreflightError({ message: `--reset: ${cause.message}` })
	const { datasources } = yield* client.get(`${host.value}/v0/datasources`).pipe(
		Effect.flatMap((response) => response.json),
		Effect.flatMap(Schema.decodeUnknownEffect(Datasources)),
		Effect.mapError(fail),
	)
	yield* Effect.forEach(
		datasources,
		({ name }) =>
			client.post(`${host.value}/v0/datasources/${name}/truncate`).pipe(Effect.mapError(fail)),
		{ concurrency: 4, discard: true },
	)

	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const watermark = new Date(incidentAt - 5 * MINUTE).toISOString()
	yield* spawner
		.string(
			ChildProcess.make("psql", [
				pgUrl.value,
				// One transaction: a failed watermark upsert must not leave the error state truncated.
				"--single-transaction",
				"-v",
				"ON_ERROR_STOP=1",
				"-c",
				`TRUNCATE ${ERROR_STATE_TABLES.join(", ")} CASCADE`,
				"-c",
				`INSERT INTO error_tick_states (org_id, processed_through, bootstrap_completed, updated_at)
				 VALUES ('${orgId}', '${watermark}', true, now())
				 ON CONFLICT (org_id) DO UPDATE SET processed_through = EXCLUDED.processed_through,
				   bootstrap_completed = true, claim_token = NULL, claim_expires_at = NULL, updated_at = now()`,
			]),
			{ includeStderr: true },
		)
		.pipe(Effect.mapError(fail))
	yield* Console.log(`  reset: ${datasources.length} datasources truncated, error state cleared`)
})

// ── sending ─────────────────────────────────────────────────────────────────

const post = Effect.fn("seedDemo.post")(
	function* (target: Target, path: string, body: unknown) {
		const client = yield* HttpClient.HttpClient
		const request = HttpClientRequest.post(`${target.endpoint}${path}`).pipe(
			HttpClientRequest.bearerToken(target.key),
			HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
		)
		const response = yield* client
			.execute(request)
			.pipe(Effect.mapError((cause) => new SeedIngestError({ message: cause.message, path })))
		if (response.status >= 300) {
			const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
			return yield* new SeedIngestError({ message: `${response.status}: ${text.slice(0, 300)}`, path })
		}
	},
	Effect.retry({ times: 3, schedule: Schedule.exponential("250 millis") }),
)

const chunk = <T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> =>
	Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

const requestsFor = (out: WindowOutput) => [
	...out.spans.flatMap((group) =>
		chunk(group.items, SPANS_PER_REQUEST).map((spans) => ({
			path: "/v1/traces",
			body: resourceSpans(group.resource.attributes, spans),
		})),
	),
	...out.logs.map((group) => ({
		path: "/v1/logs",
		body: resourceLogs(group.resource.attributes, group.items),
	})),
	...out.metrics.map((group) => ({
		path: "/v1/metrics",
		body: resourceMetrics(group.resource.attributes, group.items),
	})),
]

const count = <T>(groups: ReadonlyArray<Grouped<T>>) =>
	groups.reduce((total, group) => total + group.items.length, 0)

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

// ── command ─────────────────────────────────────────────────────────────────

const seed = Command.make(
	"seed-demo",
	{
		endpoint: Flag.String("endpoint").pipe(
			Flag.withDescription("Ingest gateway base URL"),
			Flag.withDefault(Option.getOrElse(env("MAPLE_INGEST_URL"), () => "http://localhost:3474")),
		),
		key: Flag.String("key").pipe(
			Flag.withDescription("Ingest key for the org to seed (env MAPLE_INGEST_KEY)"),
			Flag.withDefault(Option.getOrElse(env("MAPLE_INGEST_KEY"), () => "maple_pk_local")),
		),
		hours: Flag.Int("hours").pipe(
			Flag.withDescription("How much history to backfill"),
			Flag.withDefault(24),
		),
		rate: Flag.Int("rate").pipe(Flag.withDescription("Peak traces per minute"), Flag.withDefault(60)),
		incidentMinutes: Flag.Int("incident-minutes").pipe(
			Flag.withDescription("How long before the anchor the bad payment-svc deploy lands"),
			Flag.withDefault(120),
		),
		anchor: Flag.String("anchor").pipe(
			Flag.withDescription(
				'End of the seeded window: "now" or ISO-8601 (default: now, floored to 5 minutes)',
			),
			Flag.withDefault("now"),
		),
		seed: Flag.Int("seed").pipe(
			Flag.withDescription("RNG seed; same seed, same data"),
			Flag.withDefault(7),
		),
		dryRun: Flag.Boolean("dry-run").pipe(
			Flag.withDescription("Generate and count, send nothing"),
			Flag.withDefault(false),
		),
		follow: Flag.Boolean("follow").pipe(
			Flag.withDescription(
				"After the backfill, keep sending each minute live (the error tick only scans active orgs)",
			),
			Flag.withDefault(false),
		),
		reset: Flag.Boolean("reset").pipe(
			Flag.withDescription(
				"Truncate the local warehouse and the demo error state first (screenshot stack only)",
			),
			Flag.withDefault(false),
		),
		resume: Flag.Boolean("resume").pipe(
			Flag.withDescription("Skip the backfill and follow on from where the last run stopped sending"),
			Flag.withDefault(false),
		),
	},
	Effect.fn("seedDemo")(function* (flags) {
		const fs = yield* FileSystem.FileSystem
		const previous = flags.resume
			? Option.some(
					yield* fs.readFileString(STATE_FILE).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SeedState))),
						Effect.mapError(
							() =>
								new SeedPreflightError({
									message: `--resume: no readable state at ${STATE_FILE}`,
								}),
						),
					),
				)
			: Option.none()
		const target: Target = { endpoint: flags.endpoint.replace(/\/$/, ""), key: flags.key }
		const anchor = Option.match(previous, {
			onSome: (state) => DateTime.toEpochMillis(state.anchor),
			onNone: () =>
				flags.anchor === "now"
					? Math.floor(Date.now() / (5 * MINUTE)) * 5 * MINUTE
					: Option.match(Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)(flags.anchor), {
							onSome: DateTime.toEpochMillis,
							onNone: () => Number.NaN,
						}),
		})
		const hours = Option.isSome(previous) ? 0 : flags.hours
		if (Number.isNaN(anchor)) {
			return yield* new SeedPreflightError({ message: `--anchor: could not parse "${flags.anchor}"` })
		}
		const orgId = env("MAPLE_ORG_ID_OVERRIDE")

		if (!flags.dryRun) {
			yield* Console.log("preflight")
			yield* checkIngest(target)
			if (Option.isNone(orgId)) {
				yield* Console.warn(
					"  ! MAPLE_ORG_ID_OVERRIDE is unset; data lands in whatever org the ingest key resolves to",
				)
			} else {
				yield* checkWarehouseRouting(orgId.value)
				yield* Console.log(`  org ${orgId.value}`)
			}
			yield* checkWarehouse()
		}

		// A resumed run reuses the saved seed and incident, so pods and the incident line up.
		const seed = Option.match(previous, {
			onSome: (state) => state.seed ?? flags.seed,
			onNone: () => flags.seed,
		})
		const incidentBeforeAnchorMs = Option.match(previous, {
			onSome: (state) =>
				state.incidentAt === undefined
					? flags.incidentMinutes * MINUTE
					: anchor - DateTime.toEpochMillis(state.incidentAt),
			onNone: () => flags.incidentMinutes * MINUTE,
		})
		const world = new World({
			anchor,
			// A resumed run keeps the original window, so pods, versions and the incident line up.
			windowMs: Option.match(previous, {
				onSome: (state) => anchor - DateTime.toEpochMillis(state.start),
				onNone: () => hours * HOUR,
			}),
			incidentBeforeAnchorMs,
			peakTracesPerMinute: flags.rate,
			seed,
		})
		if (flags.reset && !flags.dryRun && Option.isNone(previous)) {
			if (Option.isNone(orgId)) {
				return yield* new SeedPreflightError({ message: "--reset needs MAPLE_ORG_ID_OVERRIDE" })
			}
			yield* resetDemo(orgId.value, world.incidentAt)
		}
		yield* Console.log(
			`\nseeding ${clock(world.start)} → ${clock(anchor)} (${hours}h), incident at ${clock(world.incidentAt)}` +
				(flags.dryRun ? " [dry run]" : ""),
		)

		const totals = { traces: 0, errors: 0, spans: 0, logs: 0 }
		// Seeded per window, so a follow run never replays the backfill's trace ids.
		const rngFor = (from: number) => new Rng(Math.imul(seed, 0x9e3779b1) ^ Math.floor(from / MINUTE))
		const sendWindow = (from: number, to: number) =>
			Effect.gen(function* () {
				const out = generateWindow(world, rngFor(from), from, to)
				const spans = count(out.spans)
				const logs = count(out.logs)
				totals.traces += out.traceCount
				totals.errors += out.errorTraceCount
				totals.spans += spans
				totals.logs += logs
				if (!flags.dryRun) {
					yield* Effect.forEach(requestsFor(out), ({ path, body }) => post(target, path, body), {
						concurrency: 4,
						discard: true,
					})
				}
				yield* Console.log(
					`  ${clock(from)}  ${String(out.traceCount).padStart(6)} traces  ${String(out.errorTraceCount).padStart(4)} failed  ` +
						`${String(spans).padStart(7)} spans  ${String(logs).padStart(6)} logs`,
				)
			})
		const windows = Array.from({ length: hours }, (_, i) => anchor - hours * HOUR + i * HOUR)
		yield* Effect.forEach(windows, (from) => sendWindow(from, Math.min(from + HOUR, anchor)))

		yield* Console.log(
			`\n${flags.dryRun ? "would send" : "sent"} ${totals.traces} traces (${totals.errors} failed), ${totals.spans} spans, ${totals.logs} logs`,
		)
		if (flags.dryRun) return

		const writeState = (followedThrough: number) =>
			fs.writeFileString(
				STATE_FILE,
				`${JSON.stringify(
					{
						anchor: new Date(anchor).toISOString(),
						start: new Date(world.start).toISOString(),
						incidentAt: new Date(world.incidentAt).toISOString(),
						followedThrough: new Date(followedThrough).toISOString(),
						orgId: Option.getOrNull(orgId),
						seed,
					},
					null,
					"\t",
				)}\n`,
			)
		let cursor = Option.match(previous, {
			onSome: (state) => DateTime.toEpochMillis(state.followedThrough ?? state.anchor),
			onNone: () => anchor,
		})
		yield* writeState(cursor)
		yield* Console.log(
			`anchor written to ${STATE_FILE}\nData arrives through the pipeline; give it a minute to appear.`,
		)
		if (!flags.follow && !flags.resume) return

		yield* Console.log(`\nfollowing from ${clock(cursor)}: one window per minute, Ctrl-C to stop`)
		yield* Effect.gen(function* () {
			const end = Math.floor(Date.now() / MINUTE) * MINUTE
			const catchUp = Array.from(
				{ length: Math.ceil((end - cursor) / HOUR) },
				(_, i) => cursor + i * HOUR,
			)
			yield* Effect.forEach(catchUp, (from) =>
				Effect.gen(function* () {
					const to = Math.min(from + HOUR, end)
					yield* sendWindow(from, to)
					cursor = to
					yield* writeState(cursor)
				}),
			).pipe(
				// A restarting gateway is not fatal: the unsent windows go again next minute.
				Effect.catchTag("@maple/seed-demo/IngestError", (error) =>
					Console.warn(`  ! ${error.path}: ${error.message}; retrying next minute`),
				),
			)
			yield* Effect.sleep(`${MINUTE - (Date.now() % MINUTE) + 2_000} millis`)
		}).pipe(Effect.forever)
	}),
).pipe(Command.withDescription("Seed the local stack with the Acme Shop demo world"))

Command.run(seed, { version: "1.0.0" }).pipe(
	Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
	NodeRuntime.runMain,
)
