/**
 * The sandbox Worker and its Durable Object, which owns one container per repository per org.
 * It must stay a plain bundle entry: an alchemy-generated entry would drop the `Sandbox` and
 * `DirectoryBackupGateway` exports. Reached only over a service binding; request handling lives
 * in `handle.ts`, and everything the container is asked to do in `checkout.ts`.
 */
import { DirectoryBackup, SandboxBackupError } from "@cloudflare/sandbox"
import { SandboxExecRequest, SandboxExecResponse, SandboxRunUnavailable } from "@maple/domain/sandbox"
import { DurableObject } from "cloudflare:workers"
import { Duration, Effect, Option, Schema } from "effect"
import { SandboxCallError, type SandboxContainer, commandArgv, execute, isTimedOut } from "./checkout"
import { handle } from "./handle"
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

const decodeRequest = Schema.decodeEffect(SandboxExecRequest)
const encodeResponse = Schema.encodeSync(SandboxExecResponse)

const attempt = <A>(what: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: () => run(),
		catch: (cause) =>
			new SandboxCallError({
				message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
				cause,
			}),
	})

const decoder = new TextDecoder()

/** The repository's container. Its one RPC method is {@link Sandbox.run}. */
export class Sandbox extends DurableObject<SandboxWorkerEnv> {
	private readonly backups: DirectoryBackup | undefined
	/** Set up once per container; cleared when the container stops so the next call starts one. */
	private setup: Promise<void> | undefined
	private backupRunning = false
	/** Shared in-flight restore: two clones claimed at once must not both replace the seed. */
	private restoring: Promise<void> | undefined

	constructor(ctx: DurableObjectState, env: SandboxWorkerEnv) {
		super(ctx, env)
		const container = ctx.container
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

	/** One sandbox request, encoded both ways because it crosses RPC: the whole of `handle.ts`'s call. */
	async run(request: typeof SandboxExecRequest.Encoded): Promise<typeof SandboxExecResponse.Encoded> {
		return Effect.runPromise(
			decodeRequest(request).pipe(
				Effect.flatMap((exec) => execute(this.port, exec)),
				// Encoded by the same module in the same bundle; reaching this is a bug.
				Effect.orElseSucceed(
					() => new SandboxRunUnavailable({ message: "the sandbox could not read the request" }),
				),
				Effect.map(encodeResponse),
			),
		)
	}

	/** The running container. `exec()` itself waits out one that is still booting. */
	private readonly running = Effect.suspend(() => {
		const container = this.ctx.container
		if (container === undefined)
			return Effect.fail(
				new SandboxCallError({ message: "no container is bound to this Durable Object" }),
			)
		return attempt("start the container", () => {
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
		}).pipe(Effect.as(container))
	})

	private readonly port: SandboxContainer = {
		exec: (command, options) =>
			Effect.gen({ self: this }, function* () {
				const container = yield* this.running
				const argv = [...commandArgv(command, options?.timeout)]
				const [elapsed, output] = yield* Effect.timed(
					attempt(`run ${argv[0]}`, async () => {
						const process = await container.exec(argv, { env: EXEC_ENV, cwd: options?.cwd })
						return process.output()
					}),
				)
				const duration = Duration.toMillis(elapsed)
				return {
					exitCode: output.exitCode,
					stdout: decoder.decode(output.stdout),
					stderr: decoder.decode(output.stderr),
					duration,
					timedOut: isTimedOut(output.exitCode, duration, options?.timeout),
				}
			}),
		// Ignored output is what lets the process outlive this request.
		spawn: (command, env) =>
			Effect.flatMap(this.running, (container) =>
				attempt("start a background command", () =>
					container.exec(["bash", "-c", command], {
						env: { ...EXEC_ENV, ...env },
						stdout: "ignore",
						stderr: "ignore",
					}),
				),
			).pipe(Effect.asVoid),
		restoreMirror: Effect.promise(() => this.restoreMirror()),
		backupMirror: Effect.sync(() => this.backupMirror()),
	}

	private mirrorHost(): MirrorBackupHost {
		const backups = this.backups
		const unavailable = () =>
			Promise.reject(new SandboxCallError({ message: "this Worker has no backup bucket" }))
		return {
			configured: backups !== undefined,
			exec: (command) => Effect.runPromise(this.port.exec(command)),
			createBackup: async (options) => {
				if (backups === undefined) return unavailable()
				await Effect.runPromise(this.running)
				return backups.backup(options)
			},
			restoreBackup: async (record, dir) => {
				if (backups === undefined) return unavailable()
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

	/** Best effort and never rejects: a failed restore only costs a full fetch. */
	private restoreMirror(): Promise<void> {
		this.restoring ??= Effect.runPromise(
			restoreMirror(this.mirrorHost()).pipe(
				Effect.tap((outcome) =>
					Effect.logInfo("sandbox mirror restore").pipe(
						Effect.annotateLogs({ "maple.sandbox.mirror.restore": outcome }),
					),
				),
				Effect.catch((error) =>
					Effect.logWarning("sandbox mirror restore failed").pipe(
						Effect.annotateLogs({ "error.message": error.message }),
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
	private backupMirror(): void {
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
				run: (sandboxKey, exec) => env.Sandbox.getByName(sandboxKey).run(exec),
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
