#!/usr/bin/env bun
// Maple owns trace mining and its query catalog. Execution lives in the published builder CLI.
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Clock, Config, Console, Context, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { CH } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import * as Bench from "@maple/query-engine/benchmark"
import { collectWarehouseQueryCatalog } from "./query-bench/catalog"
import { runCli } from "@maple-dev/effect-clickhouse/benchmark/cli"

// Errors

class MissingConfigError extends Schema.TaggedError<MissingConfigError>()(
	"@maple/api/scripts/bench-queries/MissingConfigError",
	{
		what: Schema.String,
		message: Schema.String,
	},
) {}

class HttpRequestError extends Schema.TaggedError<HttpRequestError>()(
	"@maple/api/scripts/bench-queries/HttpRequestError",
	{
		url: Schema.String,
		message: Schema.String,
	},
) {}

class UpstreamStatusError extends Schema.TaggedError<UpstreamStatusError>()(
	"@maple/api/scripts/bench-queries/UpstreamStatusError",
	{
		source: Schema.String,
		status: Schema.Number,
		message: Schema.String,
	},
) {}

class BenchFileError extends Schema.TaggedError<BenchFileError>()(
	"@maple/api/scripts/bench-queries/BenchFileError",
	{
		path: Schema.String,
		op: Schema.String,
		message: Schema.String,
	},
) {}

class InvalidDurationError extends Schema.TaggedError<InvalidDurationError>()(
	"@maple/api/scripts/bench-queries/InvalidDurationError",
	{
		input: Schema.String,
		message: Schema.String,
	},
) {}

// Internal data shapes (typed JSON; not branded — local dev tool)

interface Sample {
	readonly fingerprint: string
	readonly context: string
	readonly profile: string
	readonly sampleSql: string
	readonly sampleCount: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly p99DurationMs: number
	readonly maxDurationMs: number
}

interface FetchOutput {
	readonly fetchedAt: string
	readonly source: string
	readonly criteria: {
		readonly orgId: string
		readonly startTime: string
		readonly endTime: string
		readonly contextFilter?: string
		readonly profileFilter?: string
		readonly topN: number
	}
	readonly samples: ReadonlyArray<Sample>
}

// BenchConfig — resolve warehouse credentials from the environment via `Config`

interface TinybirdConfig {
	readonly host: string
	readonly token: string
	readonly internalOrgId: string
}

interface BenchConfigValues {
	readonly tinybird: Option.Option<TinybirdConfig>
}

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "")

export class BenchConfig extends Context.Service<BenchConfig, BenchConfigValues>()("bench/BenchConfig", {
	make: Effect.gen(function* () {
		const tbHost = yield* Config.option(Config.string("TINYBIRD_HOST"))
		const tbToken = yield* Config.option(Config.redacted("TINYBIRD_TOKEN"))
		const internalOrgId = yield* Config.string("MAPLE_INTERNAL_ORG_ID").pipe(
			Config.withDefault("internal"),
		)

		const tinybird = Option.zipWith(tbHost, tbToken, (host, token) => ({
			host: stripTrailingSlash(host),
			token: Redacted.value(token),
			internalOrgId,
		}))

		return { tinybird } satisfies BenchConfigValues
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

// Tinybird client — source for mining db.query.text spans

interface TinybirdApi {
	readonly query: (
		sql: string,
	) => Effect.Effect<
		ReadonlyArray<Record<string, unknown>>,
		HttpRequestError | UpstreamStatusError | MissingConfigError
	>
	readonly host: Effect.Effect<string, MissingConfigError>
	readonly internalOrgId: Effect.Effect<string, MissingConfigError>
}

export class Tinybird extends Context.Service<Tinybird, TinybirdApi>()("bench/Tinybird", {
	make: Effect.gen(function* () {
		const { tinybird } = yield* BenchConfig
		const httpClient = yield* HttpClient.HttpClient

		const requireConfig: Effect.Effect<TinybirdConfig, MissingConfigError> = Option.match(tinybird, {
			onNone: () =>
				Effect.fail(
					new MissingConfigError({
						what: "TINYBIRD_HOST/TINYBIRD_TOKEN",
						message:
							"TINYBIRD_HOST and TINYBIRD_TOKEN are required to mine recent db.query.text spans " +
							"from production traces.",
					}),
				),
			onSome: (cfg) => Effect.succeed(cfg),
		})

		const query = Effect.fn("Tinybird.query")(function* (sql: string) {
			const cfg = yield* requireConfig
			const url = `${cfg.host}/v0/sql?q=${encodeURIComponent(sql)}`
			const request = HttpClientRequest.get(url, {
				headers: { Authorization: `Bearer ${cfg.token}` },
			})
			const response = yield* httpClient
				.execute(request)
				.pipe(
					Effect.mapError(
						(cause) => new HttpRequestError({ url: cfg.host, message: String(cause) }),
					),
				)
			const text = yield* response.text.pipe(
				Effect.mapError((cause) => new HttpRequestError({ url: cfg.host, message: String(cause) })),
			)
			if (response.status < 200 || response.status >= 300) {
				return yield* Effect.fail(
					new UpstreamStatusError({
						source: "Tinybird",
						status: response.status,
						message: text.slice(0, 500),
					}),
				)
			}
			const parsed = yield* decodeJson(text, Schema.Struct({ data: Schema.Array(JsonRow) })).pipe(
				Effect.mapError((cause) => new HttpRequestError({ url: cfg.host, message: cause.message })),
			)
			return parsed.data
		})

		return {
			query,
			host: requireConfig.pipe(Effect.map((c) => c.host)),
			internalOrgId: requireConfig.pipe(Effect.map((c) => c.internalOrgId)),
		} satisfies TinybirdApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(BenchConfig.layer))
}

// File IO via the core FileSystem service

const decodeJson = <A>(text: string, schema: Schema.Decoder<A>) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError((cause) => new Bench.BenchmarkError({ message: String(cause) })),
	)

const JsonRow = Schema.Record(Schema.String, Schema.Unknown)
const writeJsonFile = (path: string, value: unknown) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs
			.makeDirectory(dirname(resolve(path)), { recursive: true })
			.pipe(
				Effect.mapError((cause) => new BenchFileError({ path, op: "mkdir", message: String(cause) })),
			)
		yield* fs
			.writeFileString(path, JSON.stringify(value, null, 2))
			.pipe(
				Effect.mapError((cause) => new BenchFileError({ path, op: "write", message: String(cause) })),
			)
	})

// Pure helpers — time, formatting, stats, table

const parseRelativeDuration = (input: string): Effect.Effect<number, InvalidDurationError> => {
	const match = /^(\d+)\s*(s|m|h|d)$/i.exec(input.trim())
	if (!match) {
		return Effect.fail(
			new InvalidDurationError({
				input,
				message: `Expected NNs / NNm / NNh / NNd (e.g. 24h, 7d), got "${input}".`,
			}),
		)
	}
	const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!.toLowerCase()]!
	return Effect.succeed(Number(match[1]) * unit)
}

const formatCHDateTime = (d: Date): string => {
	const pad = (n: number) => String(n).padStart(2, "0")
	return (
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
	)
}

const formatMs = (ms: number | null | undefined): string => {
	if (ms == null || Number.isNaN(ms)) return "—"
	if (ms < 1) return `${ms.toFixed(2)}ms`
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

const formatRows = (n: number | null | undefined): string => {
	if (n == null || Number.isNaN(n)) return "—"
	if (n < 1_000) return String(n)
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
	if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	return `${(n / 1_000_000_000).toFixed(2)}B`
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

interface Column {
	readonly header: string
	readonly width: number
	readonly align?: "right"
}

const renderTable = (
	title: string,
	columns: ReadonlyArray<Column>,
	rows: ReadonlyArray<ReadonlyArray<string>>,
): string => {
	const pad = (value: string, col: Column) => {
		const t = truncate(value, col.width)
		return col.align === "right" ? t.padStart(col.width) : t.padEnd(col.width)
	}
	const innerWidth = columns.reduce((sum, c) => sum + c.width, 0) + (columns.length - 1) * 3
	const border = "─".repeat(innerWidth + 2)
	const titleLine = ` ${title} `
	const titleBorderRight = "─".repeat(Math.max(0, innerWidth + 2 - titleLine.length - 2))
	const lines: string[] = []
	lines.push(`┌─${titleLine}${titleBorderRight}┐`)
	lines.push(`│ ${columns.map((c) => pad(c.header, c)).join(" │ ")} │`)
	lines.push(`├${border}┤`)
	for (const row of rows) lines.push(`│ ${row.map((v, i) => pad(v, columns[i]!)).join(" │ ")} │`)
	lines.push(`└${border}┘`)
	return lines.join("\n")
}

const artifactDirectory = fileURLToPath(new URL(".bench/", import.meta.url))
const defaultOutput = (name: string) => resolve(artifactDirectory, `${name}-${timestampSlug()}.json`)

const timestampSlug = () => new Date().toISOString().replace(/[:.]/g, "-")

// Handlers

interface FetchConfig {
	readonly context: Option.Option<string>
	readonly profile: Option.Option<string>
	readonly since: string
	readonly top: number
	readonly out: Option.Option<string>
	readonly org: Option.Option<string>
}

const fetchHandler = Effect.fn("bench.fetch")(function* (config: FetchConfig) {
	const tinybird = yield* Tinybird
	const sinceMs = yield* parseRelativeDuration(config.since)
	const nowMs = yield* Clock.currentTimeMillis
	const startTime = formatCHDateTime(new Date(nowMs - sinceMs))
	const endTime = formatCHDateTime(new Date(nowMs))
	const topN = config.top
	const orgId = yield* Option.match(config.org, {
		onNone: () => tinybird.internalOrgId,
		onSome: (o) => Effect.succeed(o),
	})
	const host = yield* tinybird.host

	const compiled = yield* CH.compile(
		Integrations.dbStatementSamplesQuery({
			contextFilter: Option.getOrUndefined(config.context),
			profileFilter: Option.getOrUndefined(config.profile),
			limit: topN,
		}),
		{ orgId, startTime, endTime },
	)

	yield* Console.log(`Mining db.query.text spans from ${host}`)
	yield* Console.log(`  org: ${orgId}   window: ${startTime} → ${endTime} (${config.since})   top: ${topN}`)

	const rows = yield* tinybird.query(compiled.sql)
	const samples: ReadonlyArray<Sample> = yield* compiled.decodeRows(rows)

	if (samples.length === 0) {
		yield* Console.log("No samples found. Widen --since or drop filters.")
		return
	}

	const outputPath = Option.getOrElse(config.out, () => defaultOutput("queries"))
	const output: FetchOutput = {
		fetchedAt: new Date(nowMs).toISOString(),
		source: host,
		criteria: {
			orgId,
			startTime,
			endTime,
			contextFilter: Option.getOrUndefined(config.context),
			profileFilter: Option.getOrUndefined(config.profile),
			topN,
		},
		samples,
	}
	yield* writeJsonFile(outputPath, output)

	yield* Console.log(
		renderTable(
			`Top ${samples.length} queries by p95 duration`,
			[
				{ header: "context", width: 28 },
				{ header: "profile", width: 12 },
				{ header: "fingerprint", width: 16 },
				{ header: "count", width: 8, align: "right" },
				{ header: "p50", width: 8, align: "right" },
				{ header: "p95", width: 8, align: "right" },
				{ header: "p99", width: 8, align: "right" },
			],
			samples.map((s) => [
				s.context || "—",
				s.profile || "—",
				s.fingerprint,
				formatRows(s.sampleCount),
				formatMs(s.p50DurationMs),
				formatMs(s.p95DurationMs),
				formatMs(s.p99DurationMs),
			]),
		),
	)
	yield* Console.log(`\nWrote ${outputPath}`)
})

const filterSuite = (suite: Bench.Suite, match: Option.Option<string>) =>
	Bench.validateSuite({
		...suite,
		samples: Option.isSome(match)
			? suite.samples.filter((sample) =>
					`${Bench.sampleId(sample)} ${sample.context}`
						.toLowerCase()
						.includes(match.value.toLowerCase()),
				)
			: suite.samples,
	})

const catalogHandler = Effect.fn("bench.catalog")(function* (config: {
	readonly match: Option.Option<string>
	readonly suite: Option.Option<string>
	readonly out: Option.Option<string>
}) {
	const suite = yield* Option.match(config.suite, {
		onSome: (path) =>
			Effect.tryPromise({
				try: () =>
					import(pathToFileURL(resolve(path)).href).then(
						(module: { default: unknown }) => module.default,
					),
				catch: (cause) => new BenchFileError({ path, op: "import suite", message: String(cause) }),
			}).pipe(
				Effect.flatMap((value) =>
					Effect.isEffect(value)
						? (value as Effect.Effect<unknown, unknown>).pipe(
								Effect.mapError(
									(cause) =>
										new BenchFileError({
											path,
											op: "compile suite",
											message: String(cause),
										}),
								),
							)
						: Effect.succeed(value),
				),
				Effect.flatMap(Schema.decodeUnknownEffect(Bench.Suite)),
			),
		onNone: () => collectWarehouseQueryCatalog().pipe(Effect.flatMap(Bench.suiteFromCatalog)),
	})
	const selected = yield* filterSuite(suite, config.match)
	const path = Option.getOrElse(config.out, () => defaultOutput("catalog"))
	yield* writeJsonFile(path, selected)
	yield* Console.log(selected.samples.map((sample) => Bench.sampleId(sample)).join("\n"))
	yield* Console.log(`\nWrote ${selected.samples.length} cases to ${path}`)
	if (Option.isNone(config.suite))
		yield* Console.log(
			"Catalog fixtures use org_sql_catalog and synthetic dates/filters. Use --suite for a representative tenant and fixed window.",
		)
})

// CLI command tree (effect/unstable/cli)

const fetchCommand = Command.make(
	"fetch",
	{
		context: Flag.string("context").pipe(
			Flag.withDescription("Filter by query.context label"),
			Flag.optional,
		),
		profile: Flag.string("profile").pipe(Flag.withDescription("Filter by query.profile"), Flag.optional),
		since: Flag.string("since").pipe(
			Flag.withDescription("Look-back window, e.g. 24h or 7d"),
			Flag.withDefault("24h"),
		),
		top: Flag.integer("top").pipe(
			Flag.withDescription("Number of fingerprints to keep"),
			Flag.withDefault(20),
		),
		out: Flag.string("out").pipe(Flag.withDescription("Output JSON path"), Flag.optional),
		org: Flag.string("org").pipe(Flag.withDescription("Source org (default: internal)"), Flag.optional),
	},
	fetchHandler,
).pipe(Command.withDescription("Mine recent db.query.text spans from production traces into a JSON file"))

const matchFlag = Flag.string("match").pipe(
	Flag.withDescription("Case ID/context substring filter"),
	Flag.optional,
)
const outFlag = Flag.string("out").pipe(Flag.withDescription("Output JSON path"), Flag.optional)
const catalogCommand = Command.make(
	"catalog",
	{
		match: matchFlag,
		out: outFlag,
		suite: Flag.string("suite").pipe(
			Flag.withDescription("TS module exporting a benchmark suite (default export)"),
			Flag.optional,
		),
	},
	catalogHandler,
).pipe(
	Command.withDescription("Compile real catalog fixtures or a custom TypeScript suite without a warehouse"),
)

const rootCommand = Command.make("bench-queries").pipe(
	Command.withDescription("Measure ClickHouse query performance"),
	Command.withSubcommands([catalogCommand, fetchCommand]),
)

const BenchServicesLive = Tinybird.layer.pipe(Layer.provide(FetchHttpClient.layer))
const BenchLive = Layer.mergeAll(BenchServicesLive, BunServices.layer)

if (["catalog", "fetch"].includes(process.argv[2] ?? "")) {
	Command.run(rootCommand, { version: "0.2.0" }).pipe(
		// Application root: this is the one runtime boundary that owns the complete layer graph.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(BenchLive),
		BunRuntime.runMain,
	)
} else {
	process.exitCode = await runCli(process.argv.slice(2))
}
