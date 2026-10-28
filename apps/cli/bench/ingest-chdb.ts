// In-process breakdown of one ingest request against a scratch chDB store:
//   stages    decode → encode → build SQL → exec, per export size
//   settings  insert cost under candidate session settings
//   views     marginal insert cost of each materialized view on the source table
//   sustained back-to-back traces exports, listing every insert slower than 500 ms
//
//   bun run bench:ingest:chdb [--signals traces,logs,metrics] [--sizes 1,50,500]
//     [--iterations 20] [--views-signal traces] [--views-size 1]
//     [--settings parallel_view_processing=0,optimize_on_insert=0] [--set name=value,...]
//     [--sustained-exports 300] [--sustained-size 50] [--skip stages,settings,views,sustained] [--out <file>]
//
// `--set` applies session settings before every section, for A/B runs of one candidate.
// The store opens with the config `maple start --in-memory` generates; `--chdb-config none`
// opens it without one, `--chdb-config <file>` with your own.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Chdb, writeIngestConfig } from "../src/server/chdb"
import { buildInsertStatements } from "../src/server/inserts"
import { type EncodedBatch, encodeLogs, encodeMetrics, encodeTraces } from "../src/server/otlp/encode"
import { LOCAL_SCHEMA_SQL } from "../src/server/schema-identity"
import { type Signal, exportBody } from "./payloads"
import { environment, flag, list, numbers, summarize, type Summary, writeReport } from "./report"

const signals = list("signals", "traces,logs,metrics") as Signal[]
const sizes = numbers("sizes", "1,50,500")
const iterations = Number(flag("iterations", "20"))
const viewsSignal = flag("views-signal", "traces") as Signal
const viewsSize = Number(flag("views-size", "1"))
const settingVariants = list("settings", "parallel_view_processing=0,optimize_on_insert=0")
const sessionSettings = list("set", "")
const sustainedExports = Number(flag("sustained-exports", "300"))
const sustainedSize = Number(flag("sustained-size", "50"))
const chdbConfig = flag("chdb-config", "default")
const skip = new Set(list("skip", ""))
const WARMUP = 3

const encoders = {
	traces: encodeTraces,
	logs: encodeLogs,
	metrics: encodeMetrics,
} satisfies Record<Signal, typeof encodeTraces>

/** The datasource whose insert carries the signal's raw rows. */
const rawDatasource = { traces: "traces", logs: "logs", metrics: "metrics_gauge" } satisfies Record<
	Signal,
	string
>

const time = (f: () => void): number => {
	const started = performance.now()
	f()
	return performance.now() - started
}

const repeat = (n: number, f: () => number): number[] => Array.from({ length: n }, f)

const measure = (f: () => number): Summary => {
	repeat(WARMUP, f)
	return summarize(repeat(iterations, f))
}

/** Statements for one fresh export (new trace and span ids every call). */
const statementsFor = (signal: Signal, records: number) =>
	encoders[signal](JSON.parse(exportBody(signal, records))).flatMap((batch) =>
		buildInsertStatements(batch.datasource, batch.ndjson).map((s) => ({
			...s,
			datasource: batch.datasource,
		})),
	)

const execAll = (db: Chdb, signal: Signal, records: number) => {
	const statements = statementsFor(signal, records)
	return time(() => statements.forEach((s) => db.exec(s.sql)))
}

// Quoted: `system.settings` prints string values bare, and ClickHouse accepts quoted numbers.
const setSetting = (db: Chdb, name: string | undefined, value: string | undefined) =>
	db.exec(`SET ${name} = '${(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`)

const stages = (db: Chdb) =>
	signals.flatMap((signal) =>
		sizes.map((records) => {
			const parse: number[] = []
			const encode: number[] = []
			const build: number[] = []
			const exec: number[] = []
			const statementCounts: number[] = []
			repeat(WARMUP + iterations, () => {
				const body = exportBody(signal, records)
				let decoded: unknown
				parse.push(time(() => (decoded = JSON.parse(body))))
				let batches: EncodedBatch[] = []
				encode.push(time(() => (batches = encoders[signal](decoded))))
				let sql: string[] = []
				build.push(
					time(
						() =>
							(sql = batches.flatMap((b) =>
								buildInsertStatements(b.datasource, b.ndjson).map((s) => s.sql),
							)),
					),
				)
				exec.push(time(() => sql.forEach((s) => db.exec(s))))
				statementCounts.push(sql.length)
				return 0
			})
			const tail = <A>(xs: A[]) => xs.slice(WARMUP)
			const row = {
				signal,
				records,
				statements: statementCounts.at(-1) ?? 0,
				parseMs: summarize(tail(parse)),
				encodeMs: summarize(tail(encode)),
				buildSqlMs: summarize(tail(build)),
				execMs: summarize(tail(exec)),
			}
			console.log(
				`${signal.padEnd(7)} ${String(records).padStart(4)} rec  ${row.statements} stmt  ` +
					`parse ${row.parseMs.p50.toFixed(2)}  encode ${row.encodeMs.p50.toFixed(2)}  ` +
					`sql ${row.buildSqlMs.p50.toFixed(2)}  exec ${row.execMs.p50.toFixed(1)} ms (p50)`,
			)
			return row
		}),
	)

const settings = (db: Chdb) => {
	const run = (label: string) =>
		signals.map((signal) => {
			const execMs = measure(() => execAll(db, signal, 1))
			console.log(`${label.padEnd(32)} ${signal.padEnd(7)} 1 rec  exec p50 ${execMs.p50.toFixed(1)} ms`)
			return { setting: label, signal, records: 1, execMs }
		})
	const baseline = run("default")
	const variants = settingVariants.flatMap((assignment) => {
		const [name, value] = assignment.split("=")
		const current = db.query(`SELECT value FROM system.settings WHERE name = '${name}'`, "TSVRaw").trim()
		setSetting(db, name, value)
		const rows = run(assignment)
		setSetting(db, name, current)
		return rows
	})
	return [...baseline, ...variants]
}

interface ViewRow {
	readonly name: string
	readonly table: string
	readonly create: string
}

const viewsOf = (db: Chdb, source: string): ViewRow[] =>
	db
		.query(
			`SELECT t.name AS name, t.create_table_query AS create
			 FROM system.tables AS t
			 WHERE t.database = currentDatabase() AND t.engine = 'MaterializedView'
			   AND has((SELECT any(dependencies_table) FROM system.tables
			            WHERE database = currentDatabase() AND name = '${source}'), t.name)
			 ORDER BY t.name`,
		)
		.split("\n")
		.filter(Boolean)
		.map((line) => ({ ...JSON.parse(line), table: source }))

/** Drop every view on the source, then add each back alone and time the insert. */
const views = (db: Chdb) => {
	const source = rawDatasource[viewsSignal]
	const all = viewsOf(db, source)
	const insert = () => {
		const statements = statementsFor(viewsSignal, viewsSize).filter((s) => s.datasource === source)
		return time(() => statements.forEach((s) => db.exec(s.sql)))
	}
	const withAll = measure(insert)
	all.forEach((v) => db.exec(`DROP VIEW ${v.name}`))
	const withNone = measure(insert)
	console.log(
		`${source}: ${all.length} views, insert p50 ${withAll.p50.toFixed(1)} ms with all, ` +
			`${withNone.p50.toFixed(1)} ms with none`,
	)
	const perView = all.map((v) => {
		db.exec(v.create)
		const alone = measure(insert)
		db.exec(`DROP VIEW ${v.name}`)
		return {
			view: v.name,
			aloneMs: alone,
			marginalMs: Math.round((alone.p50 - withNone.p50) * 100) / 100,
		}
	})
	all.forEach((v) => db.exec(v.create))
	perView.sort((a, b) => b.marginalMs - a.marginalMs)
	perView.forEach((v) => console.log(`  ${v.view.padEnd(44)} +${v.marginalMs.toFixed(2)} ms`))
	const sumMarginal = Math.round(perView.reduce((a, v) => a + v.marginalMs, 0) * 100) / 100
	console.log(
		`  sum of marginals ${sumMarginal.toFixed(1)} ms vs all-minus-none ${(withAll.p50 - withNone.p50).toFixed(1)} ms`,
	)
	return {
		source,
		records: viewsSize,
		count: all.length,
		withAllMs: withAll,
		withNoneMs: withNone,
		sumMarginal,
		perView,
	}
}

const SLOW_INSERT_MS = 500

/** Back-to-back exports, as a busy dev machine sends them; background merges show up as slow inserts. */
const sustained = (db: Chdb) => {
	const started = performance.now()
	const samples = repeat(sustainedExports, () => execAll(db, "traces", sustainedSize))
	const elapsedSeconds = (performance.now() - started) / 1000
	const slow = samples.flatMap((ms, i) =>
		ms > SLOW_INSERT_MS ? [{ export: i + 1, ms: Math.round(ms) }] : [],
	)
	const execMs = summarize(samples)
	const slowTotalMs = slow.reduce((a, s) => a + s.ms, 0)
	console.log(
		`${sustainedExports} traces exports x ${sustainedSize} spans in ${elapsedSeconds.toFixed(1)} s: ` +
			`p50 ${execMs.p50.toFixed(1)}  p95 ${execMs.p95.toFixed(1)}  max ${execMs.max.toFixed(0)} ms, ` +
			`${slow.length} inserts over ${SLOW_INSERT_MS} ms (${(slowTotalMs / 1000).toFixed(1)} s total)`,
	)
	return { exports: sustainedExports, records: sustainedSize, elapsedSeconds, execMs, slowTotalMs, slow }
}

const main = () => {
	const env = environment()
	const root = mkdtempSync(join(tmpdir(), "maple-bench-chdb-"))
	const dataDir = join(root, "data")
	const configFile =
		chdbConfig === "none"
			? undefined
			: chdbConfig === "default"
				? join(root, "chdb-config.xml")
				: chdbConfig
	if (chdbConfig === "default" && configFile) writeIngestConfig(configFile)
	// A run that throws partway still removes its scratch store.
	let db: Chdb | undefined
	try {
		const openStarted = performance.now()
		db = Chdb.open({ dataDir, schemaSql: LOCAL_SCHEMA_SQL, configFile })
		writeChdbReport(env, db, dataDir, Math.round(performance.now() - openStarted))
	} finally {
		db?.close()
		rmSync(root, { recursive: true, force: true })
	}
}

const writeChdbReport = (env: ReturnType<typeof environment>, db: Chdb, dataDir: string, openMs: number) => {
	console.log(`store opened in ${openMs} ms at ${dataDir}`)
	sessionSettings.forEach((assignment) => {
		const [name, value] = assignment.split("=")
		setSetting(db, name, value)
	})
	const report = {
		bench: "local-ingest-chdb",
		environment: env,
		options: {
			signals,
			sizes,
			iterations,
			viewsSignal,
			viewsSize,
			settingVariants,
			sessionSettings,
			chdbConfig,
			sustainedExports,
			sustainedSize,
			skip: [...skip],
		},
		openMs,
		stages: skip.has("stages") ? [] : (console.log("\n# stages"), stages(db)),
		settings: skip.has("settings") ? [] : (console.log("\n# settings"), settings(db)),
		views: skip.has("views") ? null : (console.log("\n# views"), views(db)),
		sustained: skip.has("sustained") ? null : (console.log("\n# sustained"), sustained(db)),
	}
	console.log(`\nwrote ${writeReport(`local-ingest-chdb-${env.date.slice(0, 10)}.json`, report)}`)
}

main()
