/**
 * The sandbox Worker: the one place Cloudflare's Sandbox Durable Object is
 * hosted, and the only Worker in the fleet whose module is its own bundle entry.
 *
 * That is why this app exists rather than the container living in `apps/api`. A
 * container-backed Durable Object is a class the script must export, and
 * alchemy's Effect-native Workers generate their entry — it exports the bridge
 * classes it created and nothing else, so a third-party class declared in
 * `worker.ts` would never reach the deployed script. A plain module is used
 * verbatim, so the `Sandbox` class below is what binds.
 *
 * The api reaches this over a service binding and is the only caller: there is
 * no route and no public hostname. It carries the tenant, mints the credential
 * and decides whether to run anything; this Worker owns the container.
 *
 * Everything this Worker decides lives in `handle.ts`, which the SDK's import
 * would otherwise keep out of a test: this module is the SDK, the binding and
 * the runtime, and nothing else.
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
	/**
	 * `"true"` in local dev, where the SDK can neither presign R2 URLs nor mount FUSE: archives go
	 * through the bucket binding and restores extract instead. Same archive format.
	 */
	readonly SANDBOX_BACKUP_LOCAL_BUCKET?: string
}

/** The SDK's own marker for a sessionless command, which is what every call here uses. */
const SESSIONLESS = "__DISABLE_SESSION__"

/**
 * Cloudflare's Sandbox, plus the mirror backup (`mirror-backup.ts`). One instance per repository
 * per organization, so its storage is where that repository's backup handle belongs.
 */
export class Sandbox extends SdkSandbox<SandboxWorkerEnv> {
	private backupRunning = false
	/**
	 * The restore in flight. Two cold clones of different commits both ask; the SDK queues a second
	 * restore, which starts by unmounting the seed the first clone is copying from.
	 */
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
			// Cleared after the assignment above even when the Effect finishes synchronously, which
			// `Effect.ensuring` would not be: it would run first and leave a settled promise here.
		).finally(() => {
			this.restoring = undefined
		})
		return this.restoring
	}

	/**
	 * Returns at once: the archive is written in the background, which the container keeps alive
	 * for. One at a time per repository; a call while one runs is dropped, not queued.
	 */
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

/**
 * Idle containers sleep and take their checkouts with them, so a cold call pays
 * the clone again. Ten minutes is Cloudflare's own default and covers the gap
 * between an agent's tool calls without holding compute across investigations.
 */
const SLEEP_AFTER = "10m"

export default {
	fetch: (request: Request, env: SandboxWorkerEnv): Promise<Response> =>
		Effect.runPromise(
			handle(request, {
				token: env.SANDBOX_INTERNAL_SERVICE_TOKEN,
				// Sessionless: every command is a fresh process. The default is one
				// shared, long-lived shell, which carries `set -e` and any `exec` from
				// one command into the next — a `git grep` that matched nothing would
				// kill the session the following call expected to use.
				open: (sandboxKey) =>
					getSandbox(env.Sandbox, sandboxKey, {
						sleepAfter: SLEEP_AFTER,
						enableDefaultSession: false,
					}),
			}).pipe(
				// `handle` answers every request it can read, so a cause reaching here
				// is a bug in the request-shaped part above it — before a token has been
				// decoded, which is why this one says nothing beyond that it happened.
				Effect.catchCause((cause) =>
					Effect.logError("sandbox worker failed", cause).pipe(
						Effect.as(new Response("Sandbox error", { status: 500 })),
					),
				),
			),
		),
}
