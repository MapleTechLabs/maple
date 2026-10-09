/**
 * The sandbox Worker and its Durable Object, which owns one container per repository per org.
 * It must stay a plain bundle entry: an alchemy-generated entry would drop the `Sandbox` and
 * `DirectoryBackupGateway` exports. Reached only over a service binding; request logic lives
 * in `handle.ts`, and everything the container is asked to do in `checkout.ts`.
 */
import { DirectoryBackup, Files, SandboxBackupError } from "@cloudflare/sandbox"
import { DurableObject } from "cloudflare:workers"
import { Duration, Effect, Option, Schema } from "effect"
import type { SandboxExecResult, SandboxLike, SandboxProcess, SandboxWriteResult } from "./checkout"
import { handle } from "./handle"
import {
	claimProcessArgv,
	commandArgv,
	isSafeProcessId,
	isTimedOut,
	parseProcessStatus,
	processDir,
	processLogArgv,
	processStatusArgv,
	startProcessArgv,
} from "./processes"
import {
	MIRROR_BACKUP_KEY,
	type MirrorBackupHost,
	backupMirror,
	decodeStoredMirrorBackup,
	restoreMirror,
} from "./mirror-backup"

// Moves each mirror archive between the container and R2; reached through `ctx.exports`.
export { DirectoryBackupGateway } from "@cloudflare/sandbox"

// Types `ctx.exports` from this module's own exports, as `wrangler types` would.
declare global {
	namespace Cloudflare {
		interface GlobalProps {
			mainModule: typeof import("./worker")
			durableNamespaces: "Sandbox"
		}
	}
}

interface SandboxWorkerEnv {
	readonly Sandbox: DurableObjectNamespace<Sandbox>
	readonly SANDBOX_INTERNAL_SERVICE_TOKEN?: string
	/** Mirror archives. Without it backups are off and every cold container clones in full. */
	readonly BACKUP_BUCKET?: R2Bucket
}

/** Replaces 0.x `sleepAfter`; 10m covers the gaps between an agent's tool calls. */
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000

/** `exec()` passes on only `PATH`; git and node expect the rest of what a login shell had. */
const EXEC_ENV = { HOME: "/root", LANG: "C.UTF-8" }

class SandboxContainerError extends Schema.TaggedError<SandboxContainerError>()(
	"@maple/sandbox/SandboxContainerError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const attempt = <A>(what: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: () => run(),
		catch: (cause) =>
			new SandboxContainerError({
				message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
				cause,
			}),
	})

const decoder = new TextDecoder()

const run = (container: Container, argv: ReadonlyArray<string>, options?: { readonly cwd?: string }) =>
	attempt(`run ${argv[0]}`, async () => {
		const process = await container.exec([...argv], { env: EXEC_ENV, cwd: options?.cwd })
		const output = await process.output()
		return {
			exitCode: output.exitCode,
			stdout: decoder.decode(output.stdout),
			stderr: decoder.decode(output.stderr),
		}
	})

/** `null` for an id no process in this container has used. */
const processState = (container: Container, id: string) =>
	run(container, processStatusArgv(id)).pipe(Effect.map((result) => parseProcessStatus(id, result.stdout)))

const noBackups = () =>
	Promise.reject(new SandboxContainerError({ message: "this Worker has no backup bucket" }))

/** The repository's container, and the port `checkout.ts` drives it through. */
export class Sandbox extends DurableObject<SandboxWorkerEnv> implements SandboxLike {
	private readonly files: Files | undefined
	private readonly backups: DirectoryBackup | undefined
	/** Set up once per container; cleared when the container stops so the next call starts one. */
	private setup: Promise<void> | undefined
	private backupRunning = false
	/** Shared in-flight restore: a second restore would replace the seed a clone is moving. */
	private restoring: Promise<void> | undefined

	constructor(ctx: DurableObjectState, env: SandboxWorkerEnv) {
		super(ctx, env)
		const container = ctx.container
		this.files = container && new Files(container)
		this.backups =
			container &&
			env.BACKUP_BUCKET &&
			new DirectoryBackup(container, ctx.exports.DirectoryBackupGateway, {
				binding: "BACKUP_BUCKET",
				prefix: "mirrors/",
			})
		// A restarted Durable Object starts without a timeout, even over a running container.
		if (container?.running)
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS))
	}

	private readonly container = Effect.suspend(() =>
		this.ctx.container === undefined
			? Effect.fail(
					new SandboxContainerError({ message: "no container is bound to this Durable Object" }),
				)
			: Effect.succeed(this.ctx.container),
	)

	/** The running container. `exec()` itself waits out one that is still booting. */
	private readonly running = Effect.flatMap(this.container, (container) =>
		attempt("start the container", () => {
			if (this.setup === undefined || !container.running) {
				this.setup = (async () => {
					// The image and instance size come from the application: `default` scheduling policy.
					if (!container.running) container.start({ enableInternet: true })
					await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
				})().catch((cause: unknown) => {
					this.setup = undefined
					return Promise.reject(cause)
				})
			}
			return this.setup
		}).pipe(Effect.as(container)),
	)

	async exec(
		command: string,
		options?: { readonly cwd?: string; readonly timeout?: number },
	): Promise<SandboxExecResult> {
		const timeout = options?.timeout
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				const container = yield* this.running
				const [elapsed, result] = yield* Effect.timed(
					run(container, commandArgv(command, timeout), { cwd: options?.cwd }),
				)
				const duration = Duration.toMillis(elapsed)
				return { ...result, duration, timedOut: isTimedOut(result.exitCode, duration, timeout) }
			}),
		)
	}

	async startProcess(command: string, options?: { readonly processId?: string }): Promise<SandboxProcess> {
		const id = options?.processId ?? crypto.randomUUID()
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				if (!isSafeProcessId(id))
					return yield* new SandboxContainerError({ message: `unsafe process id: ${id}` })
				const container = yield* this.running
				const created = yield* run(container, claimProcessArgv(id))
				if (created.exitCode !== 0)
					return (yield* processState(container, id)) ?? { id, status: "starting" as const }
				// Ignored output is what lets the process outlive this request.
				yield* attempt("start a process", () =>
					container.exec([...startProcessArgv(id, command)], {
						env: EXEC_ENV,
						stdout: "ignore",
						stderr: "ignore",
					}),
				).pipe(
					// A claim with no process behind it would read as starting until the container stops.
					Effect.tapError(() => run(container, ["rm", "-rf", processDir(id)]).pipe(Effect.ignore)),
				)
				return { id, status: "starting" as const }
			}),
		)
	}

	async getProcess(id: string): Promise<SandboxProcess | null> {
		if (!isSafeProcessId(id)) return null
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				const container = yield* this.container
				// A stopped container took its processes with it.
				if (!container.running) return null
				return yield* processState(container, id)
			}),
		)
	}

	async getProcessLogs(id: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				if (!isSafeProcessId(id)) return { stdout: "", stderr: "" }
				const container = yield* this.container
				const read = (stream: "stdout" | "stderr") =>
					run(container, processLogArgv(id, stream)).pipe(Effect.map((result) => result.stdout))
				return { stdout: yield* read("stdout"), stderr: yield* read("stderr") }
			}),
		)
	}

	async writeFile(path: string, content: string): Promise<SandboxWriteResult> {
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				const files = this.files
				if (files === undefined)
					return yield* new SandboxContainerError({
						message: "no container is bound to this Durable Object",
					})
				yield* this.running
				yield* attempt("write a file", () => files.writeFile(path, content))
				return { success: true }
			}),
		)
	}

	private mirrorHost(): MirrorBackupHost {
		const backups = this.backups
		return {
			configured: backups !== undefined,
			exec: (command) => this.exec(command),
			createBackup: async (options) => {
				if (backups === undefined) return noBackups()
				await Effect.runPromise(this.running)
				return backups.backup(options)
			},
			restoreBackup: async (record, dir) => {
				if (backups === undefined) return noBackups()
				await Effect.runPromise(this.running)
				return backups.restore(record, { dir }).then(
					() => "restored" as const,
					// Missing, or no longer what the record describes: either way, never usable again.
					(cause: unknown) =>
						SandboxBackupError.is(cause) &&
						(cause.code === "BACKUP_NOT_FOUND" || cause.code === "BACKUP_INTEGRITY")
							? ("gone" as const)
							: Promise.reject(cause),
				)
			},
			readBackup: async () =>
				Option.flatMap(Option.fromNullishOr(await this.ctx.storage.get(MIRROR_BACKUP_KEY)), (value) =>
					decodeStoredMirrorBackup(value),
				),
			writeBackup: (backup) =>
				this.ctx.storage.put(MIRROR_BACKUP_KEY, {
					record: backup.record,
					createdAt: backup.createdAt,
				}),
			forgetBackup: async () => {
				await this.ctx.storage.delete(MIRROR_BACKUP_KEY)
			},
			now: () => Date.now(),
		}
	}

	/** Awaited by the clone path: the seed has to be in place before the clone script looks for it. */
	async restoreMirror(): Promise<void> {
		this.restoring ??= Effect.runPromise(
			restoreMirror(this.mirrorHost()).pipe(
				Effect.tap((outcome) =>
					Effect.logInfo("sandbox mirror restore").pipe(
						Effect.annotateLogs({ "maple.sandbox.mirror.restore": outcome }),
					),
				),
				Effect.asVoid,
			),
			// Not `Effect.ensuring`: on a synchronous finish it would clear before the assignment.
		).finally(() => {
			this.restoring = undefined
		})
		return this.restoring
	}

	/** Returns at once and archives in the background. A call while one runs is dropped. */
	async backupMirror(): Promise<void> {
		if (this.backupRunning) return
		this.backupRunning = true
		this.ctx.waitUntil(
			Effect.runPromise(
				backupMirror(this.mirrorHost()).pipe(
					Effect.tap((outcome) =>
						outcome === "created" ? Effect.logInfo("sandbox mirror backed up") : Effect.void,
					),
					Effect.catch((error) =>
						Effect.logWarning("sandbox mirror backup failed").pipe(
							Effect.annotateLogs({ "error.message": error.message }),
						),
					),
					Effect.ensuring(Effect.sync(() => (this.backupRunning = false))),
				),
			),
		)
	}
}

export default {
	fetch: (request: Request, env: SandboxWorkerEnv): Promise<Response> =>
		Effect.runPromise(
			handle(request, {
				token: env.SANDBOX_INTERNAL_SERVICE_TOKEN,
				open: (sandboxKey) => env.Sandbox.getByName(sandboxKey),
			}).pipe(
				// `handle` answers every readable request; reaching here is a bug before auth.
				Effect.catchCause((cause) =>
					Effect.logError("sandbox worker failed", cause).pipe(
						Effect.as(new Response("Sandbox error", { status: 500 })),
					),
				),
			),
		),
}
