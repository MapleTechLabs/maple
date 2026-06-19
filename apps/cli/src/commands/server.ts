import { Effect, Option, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { openSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { SCHEMA_FINGERPRINT, startServer } from "../server/serve"
import {
	checkStoreCompatible,
	isSchemaStale,
	isStoreDirty,
	storeMarkerJson,
	storeMarkerPath,
	storeOpenMarkerPath,
} from "../server/store-version"
import { resolveUiAssets } from "../server/ui-assets"
import { amber, bold, cyan, dim, green, underline } from "../lib/style"
import { MAPLE_VERSION } from "../version"

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

/** Public origin of the deployed local-mode dashboard SPA. Overridable for
 *  testing against staging (`local-staging.maple.dev`). */
const remoteUiUrl = (): string => process.env.MAPLE_LOCAL_UI_URL?.trim() || "https://local.maple.dev"

/** The startup banner shown once the server is listening. `dashboardUrl` is the
 *  URL the user should open (the auto-updating `local.maple.dev` by default, or
 *  the bundled UI on `127.0.0.1` with `--offline`); `undefined` when no UI. */
const startBanner = (
	addr: string,
	dataDir: string,
	dashboardUrl: string | undefined,
	offline: boolean,
): string => {
	const row = (key: string, value: string) => `  ${dim(key.padEnd(11))}${value}`
	const lines = [
		"",
		`  ${amber("🍁 maple")}  ${dim("· local mode")}`,
		`  ${green("●")} listening on ${cyan(underline(addr))}`,
		"",
		row("OTLP/HTTP", `POST ${dim("/v1/{traces,logs,metrics}")}`),
		row("query", `POST ${dim("/local/query")}`),
		...(dashboardUrl
			? [
					row("dashboard", cyan(dashboardUrl)),
					...(offline ? [] : [`  ${dim(" ".repeat(11))}${dim("· bundled UI: pass --offline")}`]),
				]
			: []),
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
	Flag.string("data-dir").pipe(
		Flag.withDescription("Embedded ClickHouse data directory (default: ~/.maple/data)"),
	),
)

const backgroundFlag = Flag.boolean("background").pipe(
	Flag.withAlias("d"),
	Flag.withDescription("Run the server detached (logs to ~/.maple/maple.log); stop with `maple stop`"),
	Flag.withDefault(false),
)

const resetFlag = Flag.boolean("reset").pipe(
	Flag.withDescription(
		"Wipe the existing store (~/.maple/data) before starting — use after an incompatible upgrade",
	),
	Flag.withDefault(false),
)

const yesFlag = Flag.boolean("yes").pipe(
	Flag.withAlias("y"),
	Flag.withDescription("Skip the confirmation prompt"),
	Flag.withDefault(false),
)

const offlineFlag = Flag.boolean("offline").pipe(
	Flag.withDescription(
		"Use the UI bundled in this binary (served from 127.0.0.1) instead of local.maple.dev",
	),
	Flag.withDefault(false),
)

// Log file for `--background` runs, beside the PID file (e.g. ~/.maple/maple.log).
const logFilePath = (dataDir: string): string => join(dirname(dataDir), "maple.log")

/** Non-fatal `/health` probe used while waiting for a detached server to bind. */
const probeHealth = (addr: string): Effect.Effect<boolean> =>
	Effect.tryPromise(async () => {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), 300)
		try {
			const res = await fetch(`${addr}/health`, { signal: controller.signal })
			return res.ok
		} finally {
			clearTimeout(timer)
		}
	}).pipe(Effect.orElseSucceed(() => false))

/**
 * Re-exec `maple start` detached, dropping `--background`/`-d` so the child runs
 * the normal foreground path (writes the PID, owns chDB). Output goes to the log
 * file; we poll `/health` until it binds, then print a summary and return so the
 * parent process exits.
 */
const startDetached = (port: number, dataDir: string, offline: boolean): Effect.Effect<void, ServerError> =>
	Effect.gen(function* () {
		const logPath = logFilePath(dataDir)
		// Rebuild the command explicitly rather than slicing argv: a Bun-compiled
		// binary injects a virtual `/$bunfs/...` entrypoint at argv[1] that must
		// not be forwarded. In dev (`bun run src/bin.ts`) argv[1] is the real
		// script and Bun needs it; in the compiled binary execPath alone suffices.
		const entry = process.argv[1]
		const runtimeArgs = entry && !entry.startsWith("/$bunfs") ? [entry] : []
		const childArgs = [
			...runtimeArgs,
			"start",
			"--port",
			String(port),
			"--data-dir",
			dataDir,
			...(offline ? ["--offline"] : []),
		]

		const child = yield* Effect.try({
			try: () => {
				const fd = openSync(logPath, "a")
				const proc = Bun.spawn([process.execPath, ...childArgs], {
					stdin: "ignore",
					stdout: fd,
					stderr: fd,
				})
				proc.unref()
				return proc
			},
			catch: (e) =>
				new ServerError({
					message: `failed to spawn background server: ${e instanceof Error ? e.message : String(e)}`,
				}),
		})

		const addr = `http://127.0.0.1:${port}`
		let up = false
		for (let i = 0; i < 100; i++) {
			yield* Effect.sleep("100 millis")
			if (yield* probeHealth(addr)) {
				up = true
				break
			}
			if (!isProcessAlive(child.pid)) break // child died early — stop waiting
		}
		if (!up) {
			return yield* new ServerError({
				message: `background server did not come up within 10s — check ${prettyPath(logPath)}`,
			})
		}

		yield* Effect.sync(() =>
			process.stdout.write(
				`${green("✓")} maple started in background ${dim(`(PID ${child.pid})`)}\n` +
					`  ${dim("listening")} ${cyan(underline(addr))}\n` +
					`  ${dim("logs")}      ${prettyPath(logPath)}\n` +
					`  ${dim("stop")}      ${bold("maple stop")}\n`,
			),
		)
	})

export const start = Command.make("start", {
	port,
	dataDir: dataDirFlag,
	background: backgroundFlag,
	offline: offlineFlag,
	reset: resetFlag,
}).pipe(
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

			// `--reset`: wipe the store (and its version marker) so we bootstrap fresh.
			// The escape hatch when an existing store is from an incompatible build.
			if (a.reset) {
				yield* fs.remove(dataDir, { recursive: true, force: true }).pipe(Effect.ignore)
				yield* fs.remove(storeMarkerPath(dataDir), { force: true }).pipe(Effect.ignore)
				yield* fs.remove(storeOpenMarkerPath(dataDir), { force: true }).pipe(Effect.ignore)
			}

			yield* fs.makeDirectory(dataDir, { recursive: true })

			// Refuse to open a store written by an incompatible chDB build: re-loading
			// its persisted materialized views crashes the C++ runtime natively
			// (SIGTRAP), which we cannot catch. Fresh/matching stores pass through.
			const compat = checkStoreCompatible(dataDir)
			if (!compat.compatible) {
				return yield* new ServerError({
					message:
						`the local store at ${prettyPath(dataDir)} is incompatible with this build's chDB ` +
						`(store: ${compat.found}; build: ${compat.current}) — loading it would crash chDB. ` +
						`Wipe it with \`${bold("maple reset")}\`, or start fresh via \`${bold("maple start --reset")}\`.`,
				})
			}

			// A store left "open" (the previous server died without running its close
			// finalizer) may be inconsistent — reopening it can crash chDB natively,
			// which we cannot catch. Auto-wipe and bootstrap fresh instead of walking
			// into the crash. (`--reset` already wiped above, so the marker is gone.)
			if (isStoreDirty(dataDir)) {
				yield* Effect.sync(() =>
					process.stderr.write(
						amber(
							"⚠ the local store was left inconsistent by an unclean shutdown — " +
								"wiping it and starting fresh (local telemetry data is discarded)\n",
						),
					),
				)
				yield* fs.remove(dataDir, { recursive: true, force: true }).pipe(Effect.ignore)
				yield* fs.remove(storeMarkerPath(dataDir), { force: true }).pipe(Effect.ignore)
				yield* fs.remove(storeOpenMarkerPath(dataDir), { force: true }).pipe(Effect.ignore)
				yield* fs.makeDirectory(dataDir, { recursive: true })
			}

			// A store bootstrapped from an older bundled schema can't be evolved in
			// place: `CREATE … IF NOT EXISTS` is a no-op on existing tables, so a
			// column added to the schema (e.g. ServiceNamespace on trace_list_mv)
			// never lands and facet queries referencing it fail. Rebuild from the
			// current schema. Safe to auto-wipe — local telemetry is ephemeral and
			// re-ingested — and only triggers once per schema change.
			if (isSchemaStale(dataDir, SCHEMA_FINGERPRINT)) {
				yield* Effect.sync(() =>
					process.stderr.write(
						amber(
							"⚠ the local store was built from an older schema — " +
								"rebuilding it from the current schema (local telemetry data is discarded)\n",
						),
					),
				)
				yield* fs.remove(dataDir, { recursive: true, force: true }).pipe(Effect.ignore)
				yield* fs.remove(storeMarkerPath(dataDir), { force: true }).pipe(Effect.ignore)
				yield* fs.remove(storeOpenMarkerPath(dataDir), { force: true }).pipe(Effect.ignore)
				yield* fs.makeDirectory(dataDir, { recursive: true })
			}

			// Detached: spawn the same command without --background and exit.
			if (a.background) return yield* startDetached(a.port, dataDir, a.offline)

			yield* Effect.sync(() =>
				process.stderr.write(
					dim(`◌ opening chDB at ${prettyPath(dataDir)} (bootstrapping schema)…\n`),
				),
			)
			const assets = yield* resolveUiAssets()

			// The server, PID file, and shutdown notice are all tied to this scope.
			// On SIGINT/SIGTERM, `BunRuntime.runMain` interrupts the fiber blocked on
			// `Effect.never`, closing the scope and running finalizers in reverse
			// registration order: remove PID → stop server → close chDB → print the
			// stopped notice.
			yield* Effect.scoped(
				Effect.gen(function* () {
					// Only announce "stopped" if we actually started. The finalizer is
					// registered up front so it fires on the SIGINT/SIGTERM shutdown, but
					// a startup failure also unwinds this scope — without the guard it
					// would print a misleading "✓ maple stopped" before the error.
					let started = false
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							if (started) process.stderr.write(`\n${green("✓")} maple stopped\n`)
						}),
					)

					const { port: boundPort } = yield* startServer({ port: a.port, dataDir, assets }).pipe(
						Effect.mapError((e) => new ServerError({ message: `failed to start: ${e.message}` })),
					)
					started = true

					// Bootstrap succeeded — stamp the store so a later start over an
					// incompatible binary upgrade is detected instead of crashing.
					yield* fs
						.writeFileString(
							storeMarkerPath(dataDir),
							storeMarkerJson(MAPLE_VERSION, new Date().toISOString(), SCHEMA_FINGERPRINT),
						)
						.pipe(Effect.ignore)

					yield* Effect.acquireRelease(fs.writeFileString(pidPath, String(process.pid)), () =>
						fs.remove(pidPath, { force: true }).pipe(Effect.ignore),
					)

					const addr = `http://127.0.0.1:${boundPort}`
					// Default: send users to the auto-updating UI on local.maple.dev (it
					// reaches this binary on loopback via the encoded ?port=). --offline:
					// serve the bundled UI from this origin (only when one is embedded).
					const dashboardUrl = a.offline
						? assets !== undefined
							? `${addr}/`
							: undefined
						: `${remoteUiUrl()}/?port=${boundPort}`
					yield* Effect.sync(() =>
						process.stdout.write(startBanner(addr, dataDir, dashboardUrl, a.offline)),
					)

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
				return yield* new ServerError({
					message: "maple is not running (stale PID file, cleaned up)",
				})
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

export const reset = Command.make("reset", { dataDir: dataDirFlag, yes: yesFlag }).pipe(
	Command.withDescription(
		"Delete the local chDB store (~/.maple/data) so the next `maple start` bootstraps fresh",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const fs = yield* FileSystem
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()

			// Refuse while a server still owns the store.
			const pidOpt = yield* readPid(fs, pidFilePath(dataDir))
			if (Option.isSome(pidOpt) && isProcessAlive(pidOpt.value)) {
				return yield* new ServerError({
					message: `maple is running (PID ${pidOpt.value}) — stop it first with \`maple stop\``,
				})
			}

			// Deleting a store is irreversible — require explicit confirmation.
			if (!a.yes) {
				yield* Effect.sync(() =>
					process.stderr.write(
						`This permanently deletes the local store at ${bold(prettyPath(dataDir))}.\n` +
							`Re-run with ${bold("maple reset --yes")} to confirm.\n`,
					),
				)
				return
			}

			yield* fs.remove(dataDir, { recursive: true, force: true }).pipe(Effect.ignore)
			yield* fs.remove(storeMarkerPath(dataDir), { force: true }).pipe(Effect.ignore)
			yield* fs.remove(storeOpenMarkerPath(dataDir), { force: true }).pipe(Effect.ignore)
			yield* Effect.sync(() =>
				process.stderr.write(`${green("✓")} reset — removed ${prettyPath(dataDir)}\n`),
			)
		}),
	),
)
