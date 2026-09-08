import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { Clock, DateTime, Effect, Schema } from "effect"
import * as Bench from "./index"
import { decodeJson, httpConfigFromEnv, makeHttpClient, makeHttpTransport } from "./http"

const fail = (message: string) => Effect.fail(new Bench.BenchmarkError({ message }))
const io = <A>(op: () => Promise<A>, message: string) =>
	Effect.tryPromise({ try: op, catch: () => new Bench.BenchmarkError({ message }) })
const read = (path: string) => io(() => readFile(resolve(path), "utf8"), `Cannot read ${path}`)
const write = (path: string, value: unknown) =>
	Effect.gen(function* () {
		const target = resolve(path)
		yield* io(() => mkdir(dirname(target), { recursive: true }), `Cannot create ${dirname(target)}`)
		const temporary = `${target}.${process.pid}.tmp`
		yield* io(() => writeFile(temporary, JSON.stringify(value, null, 2) + "\n"), `Cannot write ${target}`)
		yield* io(() => rename(temporary, target), `Cannot save ${target}`)
	})
const loadSuite = (path: string) =>
	Effect.gen(function* () {
		if (path.endsWith(".json"))
			return yield* read(path).pipe(
				Effect.flatMap((text) => decodeJson(text, Bench.Suite)),
				Effect.flatMap(Bench.validateSuite),
			)
		const module = yield* io(
			() => import(pathToFileURL(resolve(path)).href) as Promise<{ default: unknown }>,
			`Cannot import ${path}. Use Bun for TypeScript suites with extensionless imports or path aliases; Node accepts JavaScript and native supported TypeScript.`,
		)
		const value = Effect.isEffect(module.default)
			? yield* module.default as Effect.Effect<unknown, unknown>
			: module.default
		return yield* Schema.decodeUnknownEffect(Bench.Suite)(value).pipe(Effect.flatMap(Bench.validateSuite))
	})
const selected = (suite: Bench.Suite, match?: string, id?: string) =>
	Bench.validateSuite({
		...suite,
		samples: suite.samples.filter(
			(s) =>
				(!id || Bench.sampleId(s) === id) &&
				(!match || `${Bench.sampleId(s)} ${s.context}`.toLowerCase().includes(match.toLowerCase())),
		),
	})

const metrics = ["p95WallMs", "meanServerMs", "meanReadRows", "meanReadBytes", "meanMemoryUsage"] as const
const Budget = Schema.Struct({
	metric: Schema.Literals(metrics),
	thresholdPercent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	minDelta: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
const options = {
	json: { type: "boolean" },
	help: { type: "boolean" },
	out: { type: "string" },
	match: { type: "string" },
	case: { type: "string" },
	runs: { type: "string" },
	warmup: { type: "string" },
	dataset: { type: "string" },
	timeout: { type: "string" },
	threads: { type: "string" },
	cache: { type: "string" },
	"verify-results": { type: "boolean" },
	"result-order": { type: "string" },
	"log-wait": { type: "string" },
	cluster: { type: "string" },
	metric: { type: "string" },
	threshold: { type: "string" },
	"min-delta": { type: "string" },
	budgets: { type: "string" },
	"fail-on-regression": { type: "boolean" },
	"source-revision": { type: "string" },
} as const
const help = `ch-bench — reproducible ClickHouse query benchmarks

  doctor                           Check connection, query logs, and measurement controls
  export <suite.ts|suite.json>      Compile and freeze a suite
  run <suite.ts|suite.json>         Compile current queries and measure
  compare <baseline> <candidate>   Compare saved runs, offline
  inspect <suite.json|run.json>    Save plans for recorded SQL and current table metadata
  schema                          Print versioned artifact schemas as JSON Schema

Common: --json --out PATH --match TEXT --case ID
Run: --dataset REV --runs 20 --warmup 2 --threads N --timeout 30
     --verify-results --result-order ordered|unordered --cache warm|bypass
     --log-wait 12 --cluster NAME --source-revision REV
Compare: --metric meanReadBytes --threshold 10 --min-delta 1048576
         --budgets budgets.json (array of {metric, thresholdPercent, minDelta})
         --fail-on-regression (accepted; comparisons always gate)
Env: CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE
Exit: 0 pass, 1 regression, 2 invalid/error, 3 inconclusive.
JSON stdout contains one document; structured progress events go to stderr.
See docs/benchmarking.md and docs/benchmark-agent.md in the installed package.
`

/** Embeddable command boundary. Returns an exit code and never terminates the process. */
export const runCli = (args: ReadonlyArray<string>): Promise<number> => {
	const json = args.includes("--json")
	const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
	const progress = (message: string) =>
		Effect.sync(() =>
			process.stderr.write(
				json ? JSON.stringify({ version: 1, type: "progress", message }) + "\n" : message + "\n",
			),
		)
	const program = Effect.gen(function* () {
		const parsed = yield* Effect.try({
			try: () => parseArgs({ args: [...args], options, allowPositionals: true }),
			catch: (cause) => new Bench.BenchmarkError({ message: String(cause) }),
		})
		const { values: flags, positionals } = parsed
		const [command, file = "", second = ""] = positionals
		if (flags.help || !command) {
			process.stdout.write(help)
			return 0
		}
		const counts = new Map([
			["doctor", 1],
			["export", 2],
			["run", 2],
			["inspect", 2],
			["compare", 3],
			["schema", 1],
		])
		if (positionals.length !== counts.get(command))
			return yield* fail("Unknown command or incorrect arguments. Run ch-bench --help.")
		const common = ["json", "out", "help"]
		const filters = ["match", "case"]
		const allowed = new Map<string, ReadonlyArray<string>>([
			["doctor", ["cluster"]],
			["schema", []],
			["export", filters],
			["inspect", filters],
			[
				"run",
				[
					...filters,
					"runs",
					"warmup",
					"dataset",
					"timeout",
					"threads",
					"cache",
					"verify-results",
					"result-order",
					"log-wait",
					"cluster",
					"source-revision",
				],
			],
			["compare", ["metric", "threshold", "min-delta", "budgets", "fail-on-regression"]],
		])
		const unused = Object.keys(flags).filter(
			(flag) => !common.includes(flag) && !allowed.get(command)?.includes(flag),
		)
		if (unused.length)
			return yield* fail(`Unsupported flags for ${command}: ${unused.map((f) => `--${f}`).join(", ")}`)
		if (flags.budgets && (flags.metric || flags.threshold || flags["min-delta"]))
			return yield* fail("Use --budgets or the single-metric flags, not both.")
		const number = (
			name: "runs" | "warmup" | "timeout" | "threads" | "log-wait",
			fallback: number,
			min: number,
			max: number,
		) => {
			const value = Number(flags[name] ?? fallback)
			return Number.isInteger(value) && value >= min && value <= max
				? Effect.succeed(value)
				: fail(`${name} must be an integer between ${min} and ${max}`)
		}
		const finish = (value: unknown, code: number, defaultPath?: string) =>
			Effect.gen(function* () {
				const path = flags.out ?? defaultPath
				if (path) yield* write(path, value)
				if (json) emit({ version: 1, command, artifact: path ? resolve(path) : null, result: value })
				else {
					process.stdout.write(JSON.stringify(value, null, 2) + "\n")
					if (path) yield* progress(`Wrote ${path}`)
				}
				return code
			})
		if (command === "schema")
			return yield* finish(
				{
					version: 1,
					suite: Schema.toJsonSchemaDocument(Bench.Suite),
					run: Schema.toJsonSchemaDocument(Bench.RunOutput),
					budgets: Schema.toJsonSchemaDocument(Schema.Array(Budget)),
				},
				0,
			)
		if (command === "export") {
			const suite = yield* loadSuite(file).pipe(
				Effect.flatMap((s) => selected(s, flags.match, flags.case)),
			)
			return yield* finish({ ...suite, version: 1 }, 0, ".bench/suite.json")
		}
		if (command === "compare") {
			const baseline = yield* read(file).pipe(Effect.flatMap((s) => decodeJson(s, Bench.RunOutput)))
			const candidate = yield* read(second).pipe(Effect.flatMap((s) => decodeJson(s, Bench.RunOutput)))
			const budgets = flags.budgets
				? yield* read(flags.budgets).pipe(Effect.flatMap((s) => decodeJson(s, Schema.Array(Budget))))
				: [
						yield* Schema.decodeUnknownEffect(Budget)({
							metric: flags.metric ?? "p95WallMs",
							thresholdPercent: Number(flags.threshold ?? 10),
							minDelta: Number(flags["min-delta"] ?? 0),
						}),
					]
			const comparison = Bench.compareBudgets(baseline, candidate, budgets)
			// Preserve the single-metric report fields consumed by existing Maple tooling.
			const output = {
				...(comparison.comparisons.length === 1 ? comparison.comparisons[0] : undefined),
				...comparison,
			}
			return yield* finish(
				output,
				{ pass: 0, regression: 1, invalid: 2, inconclusive: 3 }[comparison.verdict],
			)
		}
		const client = makeHttpClient(yield* httpConfigFromEnv)
		const target = yield* client.target
		const server = yield* client.metadata
		if (command === "doctor") {
			const probe = yield* client
				.query(
					"SELECT 1 SETTINGS use_query_cache=0, use_query_condition_cache=0, log_queries=1, log_queries_probability=1 FORMAT JSONEachRow",
				)
				.pipe(Effect.result)
			const logs =
				probe._tag === "Success"
					? yield* client.collectLogs([probe.success.queryId], 12, flags.cluster)
					: { entries: [], warnings: [probe.failure.message] }
			const tables = yield* client.tables.pipe(Effect.result)
			const ready = logs.entries.length > 0 && tables._tag === "Success"
			return yield* finish(
				{
					version: 1,
					verdict: ready ? "pass" : "inconclusive",
					target,
					serverVersion: server.version,
					database: server.database,
					capabilities: {
						queryLogs: logs.entries.length > 0,
						tableMetadata: tables._tag === "Success",
						measurementControls: probe._tag === "Success",
					},
					diagnostics: ready
						? []
						: [
								{
									code: "MEASUREMENT_CAPABILITIES_MISSING",
									message: "Some evidence is unavailable",
									nextAction:
										"Check system.query_log permissions, log flushing, and --cluster; summary-only runs remain available.",
								},
							],
					warnings: logs.warnings,
				},
				ready ? 0 : 3,
			)
		}
		if (command === "inspect") {
			const input = yield* read(file).pipe(
				Effect.flatMap((s) => decodeJson(s, Schema.Union([Bench.Suite, Bench.RunOutput]))),
			)
			const suite = yield* selected(
				"samples" in input
					? input
					: {
							source: input.source,
							samples: input.results.map((r) => ({
								id: r.id,
								context: r.context,
								profile: r.profile,
								fingerprint: r.fingerprint,
								sampleSql: r.sql,
								inputs: r.inputs,
							})),
						},
				flags.match,
				flags.case,
			)
			yield* Effect.forEach(suite.samples, (s) => Bench.validateReplaySql(s.sampleSql), {
				discard: true,
			})
			const plans = yield* Effect.forEach(suite.samples, (sample) =>
				Effect.gen(function* () {
					const variants = yield* Effect.forEach(["indexes", "pipeline"] as const, (kind) =>
						Effect.gen(function* () {
							const sql = Bench.explainSql(sample.sampleSql, kind)
							const result = yield* client.run(sql).pipe(Effect.result)
							return result._tag === "Success"
								? { kind, sql, status: result.success.status, plan: result.success.body }
								: { kind, sql, status: 0, plan: result.failure.message }
						}),
					)
					return { id: Bench.sampleId(sample), sql: sample.sampleSql, variants }
				}),
			)
			const tables = yield* client.tables.pipe(Effect.result)
			const mismatch =
				"target" in input &&
				(input.target !== target ||
					input.database !== server.database ||
					input.serverVersion !== server.version)
			const verdict = plans.some((p) => p.variants.some((v) => v.status !== 200))
				? "invalid"
				: mismatch || tables._tag === "Failure"
					? "inconclusive"
					: "pass"
			return yield* finish(
				{
					version: 1,
					verdict,
					inspectedAt: DateTime.formatIso(yield* DateTime.now),
					target,
					serverVersion: server.version,
					database: server.database,
					source: suite.source,
					plans,
					tables: tables._tag === "Success" ? tables.success : [],
					warnings: [
						...(mismatch ? ["Inspection target/version differs from recorded run"] : []),
						...(tables._tag === "Failure" ? [tables.failure.message] : []),
						"Plans and table metadata describe the current server, using recorded SQL.",
					],
				},
				verdict === "pass" ? 0 : verdict === "invalid" ? 2 : 3,
				".bench/plans.json",
			)
		}
		const runs = yield* number("runs", 20, 1, 1000)
		const warmup = yield* number("warmup", 2, 0, 100)
		const timeout = yield* number("timeout", 30, 1, 3600)
		const logWait = yield* number("log-wait", 12, 0, 60)
		const threads = flags.threads === undefined ? undefined : yield* number("threads", 1, 1, 256)
		const cache = flags.cache ?? "warm"
		const resultOrder = flags["result-order"] ?? "unordered"
		if (!["warm", "bypass"].includes(cache) || (resultOrder !== "ordered" && resultOrder !== "unordered"))
			return yield* fail("Invalid --cache or --result-order")
		const suite = yield* loadSuite(file).pipe(Effect.flatMap((s) => selected(s, flags.match, flags.case)))
		const settings = {
			max_execution_time: String(timeout),
			use_query_cache: "0",
			use_query_condition_cache: "0",
			log_queries: "1",
			log_query_settings: "1",
			log_queries_probability: "1",
			...(threads === undefined ? undefined : { max_threads: String(threads) }),
			...(cache === "bypass"
				? { enable_filesystem_cache: "0", use_uncompressed_cache: "0" }
				: undefined),
		}
		const verifyResults = flags["verify-results"] ?? false
		const tableMetadata = yield* client.tables.pipe(Effect.result)
		const schemaHash =
			tableMetadata._tag === "Success"
				? createHash("sha256")
						.update(
							Bench.canonicalJson(
								tableMetadata.success.map((t) => ({
									name: t.name,
									ddl: t.create_table_query,
								})),
							),
						)
						.digest("hex")
				: undefined
		const result = yield* Bench.runSuite(
			makeHttpTransport(client, {
				timeoutSeconds: timeout,
				logWaitSeconds: logWait,
				cluster: flags.cluster,
				verifyResults,
				resultOrder,
			}),
			suite,
			{ runs, warmup, settings, verifyResults },
			(event) =>
				Effect.sync(() =>
					process.stderr.write(
						json ? JSON.stringify({ version: 1, ...event }) + "\n" : event.message + "\n",
					),
				),
		)
		if (tableMetadata._tag === "Failure")
			result.warnings.push("Schema metadata unavailable; schema equivalence was not checked.")
		const output: Bench.RunOutput = {
			version: 1,
			ranAt: DateTime.formatIso(yield* DateTime.now),
			target,
			database: server.database,
			serverVersion: server.version,
			dataset: flags.dataset ?? suite.dataset ?? "unspecified",
			sourceFile: resolve(file),
			source: suite.source,
			runsPerQuery: runs,
			warmupRuns: warmup,
			settings,
			verifyResults,
			resultOrder,
			sourceRevision: flags["source-revision"],
			schemaHash,
			...result,
		}
		return yield* finish(
			output,
			result.results.some((r) => r.error) ? 2 : 0,
			`.bench/run-${yield* Clock.currentTimeMillis}.json`,
		)
	})
	// The CLI is the sole Effect runtime boundary; errors become a machine-readable result.
	return Effect.runPromise(
		program.pipe(
			Effect.catchDefect((cause) => fail(`Unexpected benchmark failure: ${String(cause)}`)),
			Effect.match({
				onFailure: (error) => {
					const message = String(error)
					if (json)
						emit({
							version: 1,
							command: args[0],
							verdict: "invalid",
							diagnostics: [
								{
									code: "BENCHMARK_ERROR",
									message,
									nextAction:
										"Correct the reported input or connection error and rerun. Use ch-bench --help for supported arguments.",
								},
							],
						})
					else process.stderr.write(message + "\n")
					return 2
				},
				onSuccess: (code) => code,
			}),
		),
	)
}
