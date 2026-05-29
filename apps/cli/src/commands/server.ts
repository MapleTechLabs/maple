import { Effect, Option } from "effect"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { startServer } from "../server/serve"
import { resolveUiAssets } from "../server/ui-assets"

const defaultDataDir = (): string => join(homedir(), ".maple", "data")

// PID file lives one level above the data dir (e.g. ~/.maple/maple.pid) so
// `maple stop` finds it without knowing the full data path.
const pidFilePath = (dataDir: string): string => join(dirname(dataDir), "maple.pid")

const readPid = (path: string): number | undefined => {
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
		return Number.isFinite(pid) ? pid : undefined
	} catch {
		return undefined
	}
}

const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0) // signal 0 = liveness probe
		return true
	} catch {
		return false
	}
}

const port = Flag.integer("port").pipe(
	Flag.withDescription("Port for OTLP/HTTP ingest, the query API, and the bundled UI"),
	Flag.withDefault(4318),
)

const dataDirFlag = Flag.optional(
	Flag.string("data-dir").pipe(Flag.withDescription("Embedded ClickHouse data directory (default: ~/.maple/data)")),
)

export const start = Command.make("start", { port, dataDir: dataDirFlag }).pipe(
	Command.withDescription("Start the local ingest + query server (embedded ClickHouse via chDB)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()
			const pidPath = pidFilePath(dataDir)

			// Already-running guard.
			const existingPid = readPid(pidPath)
			if (existingPid !== undefined && isProcessAlive(existingPid)) {
				yield* Effect.logError(`maple is already running (PID ${existingPid}). Run \`maple stop\` to stop it.`)
				return yield* Effect.sync(() => process.exit(1))
			}
			if (existingPid !== undefined) rmSync(pidPath, { force: true }) // stale

			mkdirSync(dataDir, { recursive: true })

			process.stderr.write(`Opening chDB at ${dataDir} (bootstrapping schema)…\n`)
			let server: ReturnType<typeof startServer>
			try {
				server = startServer({ port: a.port, dataDir, assets: resolveUiAssets() })
			} catch (e) {
				process.stderr.write(`Failed to start: ${(e as Error).message}\n`)
				return process.exit(1)
			}

			writeFileSync(pidPath, String(process.pid))

			const addr = `http://127.0.0.1:${server.port}`
			yield* Effect.sync(() => {
				process.stdout.write(
					`maple listening on ${addr}\n` +
						`  OTLP/HTTP:  POST /v1/{traces,logs,metrics}\n` +
						`  query API:  POST /local/query  { "sql": "…" }\n` +
						`  UI:         ${addr}/\n` +
						`  PID:        ${process.pid}  (stop with \`maple stop\`)\n`,
				)
			})

			// Block until a shutdown signal; then stop the server and clean up.
			yield* Effect.promise(
				() =>
					new Promise<void>((resolve) => {
						let done = false
						const shutdown = () => {
							if (done) return
							done = true
							server.stop()
							rmSync(pidPath, { force: true })
							resolve()
						}
						process.once("SIGINT", shutdown)
						process.once("SIGTERM", shutdown)
					}),
			)
			yield* Effect.sync(() => process.stderr.write("\nmaple stopped.\n"))
		}),
	),
)

export const stop = Command.make("stop", { dataDir: dataDirFlag }).pipe(
	Command.withDescription("Stop a running `maple start` server"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()
			const pidPath = pidFilePath(dataDir)
			const pid = readPid(pidPath)

			if (pid === undefined) {
				yield* Effect.logError(`maple is not running (no PID file at ${pidPath}).`)
				return yield* Effect.sync(() => process.exit(1))
			}
			if (!isProcessAlive(pid)) {
				if (existsSync(pidPath)) rmSync(pidPath, { force: true })
				yield* Effect.logError("maple is not running (stale PID file; cleaned up).")
				return yield* Effect.sync(() => process.exit(1))
			}

			yield* Effect.sync(() => {
				process.kill(pid, "SIGTERM")
				process.stderr.write(`Stopping maple (PID ${pid})`)
			})

			// Wait up to 5s for it to exit.
			for (let i = 0; i < 50; i++) {
				yield* Effect.sleep("100 millis")
				yield* Effect.sync(() => process.stderr.write("."))
				if (!isProcessAlive(pid)) {
					if (existsSync(pidPath)) rmSync(pidPath, { force: true })
					yield* Effect.sync(() => process.stderr.write("\nmaple stopped.\n"))
					return
				}
			}
			yield* Effect.logError(`\nmaple did not stop within 5s. Force-kill with: kill -9 ${pid}`)
			return yield* Effect.sync(() => process.exit(1))
		}),
	),
)
