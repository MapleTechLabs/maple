/**
 * A real ClickHouse engine for the product scenarios: chDB with Maple's local schema.
 *
 * libchdb loads through `bun:ffi`, so it cannot live in the vitest (node) process. The engine runs
 * as a spawned bun process (`packages/local-server/test/fixtures/chdb-sql-server.ts`) and the
 * warehouse's SQL client sends it every statement the tools compile. Nothing is canned: a tool's
 * number is whatever its SQL computes over the seeded rows.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { normalizeSqlForClickHouseClient, WarehouseDriverError } from "@maple/query-engine/execution"
import { installWarehouseClient } from "../../mcp/__evals__/fake-warehouse"

const SERVER = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../../packages/local-server/test/fixtures/chdb-sql-server.ts",
)

const EngineEnv = Config.all({
	library: Config.option(Config.NonEmptyString("MAPLE_LIBCHDB")),
	required: Config.option(Config.String("MAPLE_REQUIRE_LIBCHDB")),
})
/** A malformed value reads as unset, like a missing one. */
const engineEnv = () =>
	Effect.runSync(
		EngineEnv.pipe(
			Effect.orElseSucceed(() => ({ library: Option.none<string>(), required: Option.none<string>() })),
		),
	)

/** Whether this machine can run the engine: a libchdb (as the CLI's chDB suites look for it) and bun. */
export const chdbAvailable = (): boolean =>
	(Option.exists(engineEnv().library, existsSync) ||
		existsSync(join(homedir(), ".maple", "bin", "libchdb.so")) ||
		existsSync(join(homedir(), ".maple", "bin", "libchdb.dylib"))) &&
	spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0

/** CI's scenario job sets this so a missing library fails the suite instead of skipping it. */
export const chdbRequired = (): boolean => Option.contains(engineEnv().required, "1")

export class ChdbWarehouseError extends Schema.TaggedError<ChdbWarehouseError>()(
	"@maple/ai/evals/ChdbWarehouseError",
	{ message: Schema.String },
) {}

const Ready = Schema.fromJsonString(Schema.Struct({ port: Schema.Number }))
const decodeReady = Schema.decodeUnknownOption(Ready)
const decodeRow = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

/** ClickHouse ends an exception with its error name: `... (UNKNOWN_IDENTIFIER)`. */
const errorTypeOf = (message: string): string | undefined => /\(([A-Z_]+)\)\s*$/.exec(Str.trim(message))?.[1]

export interface ChdbWarehouse {
	/** One statement run for its effect: an INSERT, an OPTIMIZE. */
	readonly exec: (sql: string) => Effect.Effect<void, ChdbWarehouseError, HttpClient.HttpClient>
}

const start = Effect.acquireRelease(
	Effect.callback<{ readonly port: number; readonly stop: () => void }, ChdbWarehouseError>((resume) => {
		const root = mkdtempSync(join(tmpdir(), "maple-product-eval-"))
		// The child inherits the environment, which is where MAPLE_LIBCHDB reaches it.
		const child = spawn("bun", [SERVER, join(root, "data")], { stdio: ["ignore", "pipe", "pipe"] })
		const stop = () => {
			child.kill("SIGTERM")
			rmSync(root, { recursive: true, force: true })
		}
		let out = ""
		let err = ""
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8")
			const line = /^CHDB (.+)$/m.exec(out)?.[1]
			if (line === undefined) return
			const ready = decodeReady(line)
			if (ready._tag === "Some") resume(Effect.succeed({ port: ready.value.port, stop }))
		})
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8")
		})
		child.once("error", (cause) =>
			resume(Effect.fail(new ChdbWarehouseError({ message: `could not start bun: ${String(cause)}` }))),
		)
		child.once("exit", (code) =>
			resume(
				Effect.fail(
					new ChdbWarehouseError({
						message: `the chDB server exited with ${String(code)} before it was ready: ${Str.slice(0, 2_000)(err)}`,
					}),
				),
			),
		)
	}),
	({ stop }) => Effect.sync(stop),
)

/**
 * Start the engine and route the warehouse to it. Scoped: closing the scope stops the process and
 * removes its store. Call `restoreWarehouse()` as well when the suite ends.
 */
export const startChdbWarehouse = Effect.gen(function* () {
	const { port } = yield* start
	const base = `http://127.0.0.1:${port}`
	const send = (route: "exec" | "query", sql: string) =>
		Effect.gen(function* () {
			const http = yield* HttpClient.HttpClient
			const response = yield* http.execute(
				HttpClientRequest.post(`${base}/${route}`).pipe(
					HttpClientRequest.bodyText(sql, "text/plain"),
				),
			)
			return { status: response.status, body: yield* response.text }
		}).pipe(
			Effect.mapError(
				(cause) =>
					new WarehouseDriverError({
						reason: "transport",
						message: `the chDB server did not answer: ${String(cause)}`,
					}),
			),
		)

	const query = (sql: string) =>
		Effect.gen(function* () {
			const { status, body } = yield* send("query", normalizeSqlForClickHouseClient(sql))
			if (status >= 400) {
				const type = errorTypeOf(body)
				return yield* new WarehouseDriverError({
					reason: "server",
					status: 400,
					message: body,
					...(type === undefined ? undefined : { type }),
				})
			}
			const lines = Arr.filter(Str.split("\n")(body), (line) => Str.trim(line) !== "")
			return yield* Effect.forEach(lines, (line) => decodeRow(line)).pipe(
				Effect.mapError(
					(cause) =>
						new WarehouseDriverError({
							reason: "protocol",
							message: "the chDB server answered a row that is not JSON",
							cause,
						}),
				),
			)
		})

	installWarehouseClient(() =>
		Effect.map(HttpClient.HttpClient, (http) => ({
			sql: (statement) =>
				Effect.map(
					query(statement.text).pipe(Effect.provideService(HttpClient.HttpClient, http)),
					(data) => ({ data }),
				),
			insert: () => Effect.void,
		})),
	)

	const warehouse: ChdbWarehouse = {
		exec: (sql) =>
			send("exec", sql).pipe(
				Effect.mapError((error) => new ChdbWarehouseError({ message: error.message })),
				Effect.flatMap(({ status, body }) =>
					status >= 400
						? Effect.fail(new ChdbWarehouseError({ message: Str.slice(0, 2_000)(body) }))
						: Effect.void,
				),
			),
	}
	return warehouse
})
