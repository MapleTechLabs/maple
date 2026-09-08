import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const bin = fileURLToPath(new URL("../../dist/benchmark/bin.mjs", import.meta.url))
let directory: string
let server: Server
let url: string
const requests: string[] = []
const cli = (args: string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn("node", [bin, ...args, "--json"], {
			cwd: directory,
			env: { ...process.env, CLICKHOUSE_URL: url },
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = "",
			stderr = ""
		child.stdout.on("data", (b) => {
			stdout += b
		})
		child.stderr.on("data", (b) => {
			stderr += b
		})
		child.on("error", reject)
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
	})
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "ch-bench-test-"))
	server = createServer(async (req, res) => {
		let sql = ""
		for await (const chunk of req) sql += chunk
		requests.push(sql)
		res.setHeader(
			"x-clickhouse-summary",
			JSON.stringify({ read_rows: "100", read_bytes: "1000", elapsed_ns: "1000000", result_rows: "2" }),
		)
		if (sql.includes("version()")) res.end(JSON.stringify({ version: "26.2", database: "default" }))
		else if (sql.includes("system.query_log")) {
			res.statusCode = 403
			res.end("denied")
		} else if (sql.includes("system.tables"))
			res.end(
				JSON.stringify({
					name: "events",
					create_table_query: "CREATE TABLE events (id UInt32) ENGINE=MergeTree ORDER BY id",
				}),
			)
		else if (sql.includes("bad_query")) {
			res.statusCode = 400
			res.end("Unknown identifier")
		} else if (sql.startsWith("EXPLAIN")) res.end("ReadFromMergeTree")
		else res.end('{"id":"9007199254740993"}\n{"id":"9007199254740994"}\n')
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("Missing test server port")
	url = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()))
	await rm(directory, { recursive: true, force: true })
})
const suite = (sql = "SELECT 1") => ({
	source: "fixture",
	dataset: "snapshot",
	samples: [
		{
			id: "one",
			inputs: "{}",
			context: "one",
			profile: "",
			fingerprint: "shape",
			sampleSql: sql,
			results: "unordered",
		},
	],
})

describe("published CLI protocol", () => {
	it("loads current modules, emits clean JSON and events, and keeps missing logs explicit", async () => {
		await writeFile(join(directory, "suite.mjs"), `export default ${JSON.stringify(suite())}`)
		const first = await cli([
			"run",
			"suite.mjs",
			"--runs",
			"2",
			"--warmup",
			"0",
			"--log-wait",
			"0",
			"--out",
			"baseline.json",
		])
		expect(first.code, first.stdout + first.stderr).toBe(0)
		const envelope = JSON.parse(first.stdout)
		expect(envelope.result.results[0].runs[0]).toMatchObject({
			memoryUsage: null,
			metricSource: "summary",
			resultHash: expect.any(String),
		})
		expect(envelope.result.dataset).toBe("snapshot")
		expect(
			first.stderr
				.trim()
				.split("\n")
				.map((s) => JSON.parse(s).type),
		).toContain("round-complete")
		await writeFile(join(directory, "suite.mjs"), `export default ${JSON.stringify(suite("SELECT 2"))}`)
		const next = await cli([
			"run",
			"suite.mjs",
			"--runs",
			"2",
			"--warmup",
			"0",
			"--log-wait",
			"0",
			"--out",
			"candidate.json",
		])
		expect(next.code).toBe(0)
		expect(JSON.parse(next.stdout).result.results[0].sql).toContain("SELECT 2")
		await writeFile(
			join(directory, "budgets.json"),
			JSON.stringify([
				{ metric: "meanReadBytes", thresholdPercent: 10, minDelta: 0 },
				{ metric: "meanMemoryUsage", thresholdPercent: 10, minDelta: 0 },
			]),
		)
		const compare = await cli([
			"compare",
			"baseline.json",
			"candidate.json",
			"--budgets",
			"budgets.json",
			"--out",
			"comparison.json",
		])
		expect(compare.code).toBe(3)
		expect(JSON.parse(compare.stdout).result).toMatchObject({
			verdict: "inconclusive",
			correctness: "verified",
		})
		expect(JSON.parse(await readFile(join(directory, "comparison.json"), "utf8")).failed).toBe(true)
	})
	it("saves failures with their query IDs and completed cases", async () => {
		await writeFile(
			join(directory, "failure.json"),
			JSON.stringify({
				...suite(),
				samples: [...suite().samples, { ...suite("SELECT bad_query").samples[0], id: "bad" }],
			}),
		)
		const result = await cli([
			"run",
			"failure.json",
			"--runs",
			"2",
			"--warmup",
			"0",
			"--log-wait",
			"0",
			"--out",
			"failed.json",
		])
		expect(result.code).toBe(2)
		const saved = JSON.parse(await readFile(join(directory, "failed.json"), "utf8"))
		expect(saved.results[0].runs).toHaveLength(2)
		expect(saved.results[1]).toMatchObject({
			error: expect.stringContaining("Unknown identifier"),
			failedQueryId: expect.any(String),
		})
	})
	it("exports offline and reports invalid arguments as JSON", async () => {
		await writeFile(join(directory, "offline.json"), JSON.stringify(suite()))
		const count = requests.length
		expect((await cli(["export", "offline.json", "--out", "frozen.json"])).code).toBe(0)
		expect(requests).toHaveLength(count)
		const invalid = await cli(["run", "offline.json", "--runs", "0"])
		expect(invalid.code).toBe(2)
		expect(JSON.parse(invalid.stdout).diagnostics[0].message).toContain("runs must")
		const schema = await cli(["schema"])
		expect(schema.code, schema.stdout).toBe(0)
		expect(JSON.parse(schema.stdout).result.run).toHaveProperty("schema")
	})
})
