import { Effect, Option, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { startServer } from "../server/serve"
import { resolveUiAssets } from "../server/ui-assets"
import { amber, bold, cyan, dim, green, underline } from "../lib/style"

/** A `maple start`/`maple stop` failure. The message is shown to the user and
 *  the process exits non-zero — same role the old `process.exit(1)` paths had,
 *  but typed and handled by the CLI runtime (matches `ModeError`). */
class ServerError extends Schema.TaggedErrorClass<ServerError>()("@maple/cli/ServerError", {
	message: Schema.String,
}) {}

const defaultDataDir = (): string => join(homedir(), ".maple", "data")

/** Collapse the home directory to `~` for tidy paths. */
const prettyPath = (p: string): string => {
	const home = homedir()
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

/** The startup banner shown once the server is listening. */
const startBanner = (addr: string, dataDir: string, hasUi: boolean): string => {
	const row = (key: string, value: string) => `  ${dim(key.padEnd(11))}${value}`
	const lines = [
		"",
		`  ${amber("🍁 maple")}  ${dim("· local mode")}`,
		`  ${green("●")} listening on ${cyan(underline(addr))}`,
		"",
		row("OTLP/HTTP", `POST ${dim("/v1/{traces,logs,metrics}")}`),
		row("query", `POST ${dim("/local/query")}`),
		...(hasUi ? [row("dashboard", cyan(`${addr}/`))] : []),
		row("data", prettyPath(dataDir)),
		row("pid", `${process.pid}  ${dim("· stop with")} ${bold("maple stop")}`),
		"",
	]
	return `${lines.join("\n")}\n`
}

// PID file lives one level above the data dir (e.g. ~/.maple/maple.pid) so
// `maple stop` finds it without knowing the full data path.
const pidFilePath = (dataDir: string): string => join(dirname(dataDir), "maple.pid")

/** Read the PID file, returning `none` when it is missing or unparseable. */
const readPid = (fs: FileSystem, pidPath: string): Effect.Effect<Option.Option<number>> =>
	fs.readFileString(pidPath).pipe(
		Effect.map((raw) => {
			const pid = Number.parseInt(raw.trim(), 10)
			return Number.isFinite(pid) ? Option.some(pid) : Option.none<number>()
		}),
		Effect.orElseSucceed(() => Option.none<number>()),
	)

/** Liveness probe via signal 0 — a process primitive with no FileSystem
 *  equivalent. Never throws (errors mean "not alive"). */
const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
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
			const fs = yield* FileSystem
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()
			const pidPath = pidFilePath(dataDir)

			// Already-running guard.
			const existingPid = yield* readPid(fs, pidPath)
			if (Option.isSome(existingPid) && isProcessAlive(existingPid.value)) {
				return yield* new ServerError({
					message: `maple is already running (PID ${existingPid.value}) — stop it with \`maple stop\``,
				})
			}
			if (Option.isSome(existingPid)) yield* fs.remove(pidPath, { force: true }).pipe(Effect.ignore) // stale

			yield* fs.makeDirectory(dataDir, { recursive: true })

			yield* Effect.sync(() =>
				process.stderr.write(dim(`◌ opening chDB at ${prettyPath(dataDir)} (bootstrapping schema)…\n`)),
			)
			const assets = yield* resolveUiAssets()

			// The server, PID file, and shutdown notice are all tied to this scope.
			// On SIGINT/SIGTERM, `BunRuntime.runMain` interrupts the fiber blocked on
			// `Effect.never`, closing the scope and running finalizers in reverse
			// registration order: remove PID → stop server → close chDB → print the
			// stopped notice.
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => process.stderr.write(`\n${green("✓")} maple stopped\n`)),
					)

					const { port: boundPort } = yield* startServer({ port: a.port, dataDir, assets }).pipe(
						Effect.mapError((e) => new ServerError({ message: `failed to start: ${e.message}` })),
					)

					yield* Effect.acquireRelease(fs.writeFileString(pidPath, String(process.pid)), () =>
						fs.remove(pidPath, { force: true }).pipe(Effect.ignore),
					)

					const addr = `http://127.0.0.1:${boundPort}`
					yield* Effect.sync(() => process.stdout.write(startBanner(addr, dataDir, assets !== undefined)))

					yield* Effect.never
				}),
			)
		}),
	),
)

export const stop = Command.make("stop", { dataDir: dataDirFlag }).pipe(
	Command.withDescription("Stop a running `maple start` server"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const fs = yield* FileSystem
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()
			const pidPath = pidFilePath(dataDir)
			const pidOpt = yield* readPid(fs, pidPath)

			if (Option.isNone(pidOpt)) {
				return yield* new ServerError({ message: "maple is not running (no PID file found)" })
			}
			const pid = pidOpt.value
			if (!isProcessAlive(pid)) {
				yield* fs.remove(pidPath, { force: true }).pipe(Effect.ignore)
				return yield* new ServerError({ message: "maple is not running (stale PID file, cleaned up)" })
			}

			yield* Effect.sync(() => {
				process.kill(pid, "SIGTERM")
				process.stderr.write(dim(`◌ stopping maple (PID ${pid})`))
			})

			// Wait up to 5s for it to exit.
			for (let i = 0; i < 50; i++) {
				yield* Effect.sleep("100 millis")
				yield* Effect.sync(() => process.stderr.write(dim(".")))
				if (!isProcessAlive(pid)) {
					yield* fs.remove(pidPath, { force: true }).pipe(Effect.ignore)
					yield* Effect.sync(() => process.stderr.write(`${green("✓")} maple stopped\n`))
					return
				}
			}
			return yield* new ServerError({
				message: `\nmaple did not stop within 5s — force-kill with \`kill -9 ${pid}\``,
			})
		}),
	),
)
