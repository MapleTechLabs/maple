/**
 * The sandbox Worker, hosting Cloudflare's Sandbox DO. It must stay a plain bundle
 * entry: an alchemy-generated entry would not export the third-party `Sandbox`
 * class. Reached only over a service binding; request logic lives in `handle.ts`.
 */
import { Sandbox as SdkSandbox, getSandbox } from "@cloudflare/sandbox"
import { Effect, Option } from "effect"
import { handle } from "./handle"
import {
	MIRROR_BACKUP_KEY,
	type MirrorBackupHost,
	backupMirror,
	decodeStoredMirrorBackup,
	restoreMirror,
} from "./mirror-backup"

interface SandboxWorkerEnv {
	readonly Sandbox: DurableObjectNamespace<Sandbox>
	readonly SANDBOX_INTERNAL_SERVICE_TOKEN?: string
	// Read by the SDK itself for its backup API; all of them, or backups stay off.
	readonly BACKUP_BUCKET?: R2Bucket
	readonly BACKUP_BUCKET_NAME?: string
	readonly R2_ACCESS_KEY_ID?: string
	readonly R2_SECRET_ACCESS_KEY?: string
	readonly CLOUDFLARE_ACCOUNT_ID?: string
	/** `"true"` in local dev (no presigned R2 or FUSE): archives go through the bucket binding. */
	readonly SANDBOX_BACKUP_LOCAL_BUCKET?: string
}

/** The SDK's own marker for a sessionless command, which is what every call here uses. */
const SESSIONLESS = "__DISABLE_SESSION__"

/** Cloudflare's Sandbox plus the mirror backup. One instance per repository per org. */
export class Sandbox extends SdkSandbox<SandboxWorkerEnv> {
	private backupRunning = false
	/** Shared in-flight restore: a second SDK restore would unmount the seed a clone is copying. */
	private restoring: Promise<void> | undefined

	private mirrorHost(): MirrorBackupHost {
		const env = this.env
		const localBucket = env.SANDBOX_BACKUP_LOCAL_BUCKET === "true"
		return {
			configured:
				env.BACKUP_BUCKET !== undefined &&
				(localBucket ||
					(env.BACKUP_BUCKET_NAME !== undefined &&
						env.R2_ACCESS_KEY_ID !== undefined &&
						env.R2_SECRET_ACCESS_KEY !== undefined &&
						env.CLOUDFLARE_ACCOUNT_ID !== undefined)),
			exec: (command) => this.execWithSessionToken(command, SESSIONLESS),
			createBackup: (options) => this.createBackup({ ...options, localBucket }),
			restoreBackup: async (backup) => {
				await this.restoreBackup({ ...backup, localBucket })
			},
			readBackup: async () =>
				Option.flatMap(Option.fromNullishOr(await this.ctx.storage.get(MIRROR_BACKUP_KEY)), (value) =>
					decodeStoredMirrorBackup(value),
				),
			writeBackup: (backup) =>
				this.ctx.storage.put(MIRROR_BACKUP_KEY, { id: backup.id, createdAt: backup.createdAt }),
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

/** Sleeping drops the checkout; 10m covers gaps between an agent's tool calls. */
const SLEEP_AFTER = "10m"

export default {
	fetch: (request: Request, env: SandboxWorkerEnv): Promise<Response> =>
		Effect.runPromise(
			handle(request, {
				token: env.SANDBOX_INTERNAL_SERVICE_TOKEN,
				// Sessionless: a shared shell would carry `set -e` and `exec` across commands,
				// so one failing command could kill the session for the next.
				open: (sandboxKey) =>
					getSandbox(env.Sandbox, sandboxKey, {
						sleepAfter: SLEEP_AFTER,
						enableDefaultSession: false,
					}),
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
