import { assert, describe, it } from "@effect/vitest"
import { SANDBOX_SEED_DIR, SANDBOX_SNAPSHOT_DIR, shellQuote } from "@maple/domain/sandbox"
import { Duration, Effect, Exit, Option } from "effect"
import {
	MIRROR_BACKUP_KEY,
	MIRROR_BACKUP_REFRESH,
	MIRROR_BACKUP_TTL,
	type MirrorBackupHost,
	StoredMirrorBackup,
	backupMirror,
	restoreMirror,
} from "./mirror-backup"

const NOW = 1_800_000_000_000

interface FakeHost extends MirrorBackupHost {
	readonly store: Map<string, StoredMirrorBackup>
	readonly calls: string[]
}

/** A Durable Object with in-memory storage whose container answers scripted exit codes. */
const fakeHost = (options: {
	readonly configured?: boolean
	readonly stored?: { id: string; createdAt: number }
	readonly exits?: ReadonlyArray<number>
	readonly createFails?: boolean
}): FakeHost => {
	const store = new Map<string, StoredMirrorBackup>(
		options.stored === undefined ? [] : [[MIRROR_BACKUP_KEY, new StoredMirrorBackup(options.stored)]],
	)
	const calls: string[] = []
	let next = 0
	return {
		store,
		calls,
		configured: options.configured ?? true,
		exec: async (command) => {
			calls.push(`exec:${command.split("\n").at(-1)}`)
			return { exitCode: options.exits?.[next++] ?? 0, stderr: "" }
		},
		createBackup: async (backup) => {
			calls.push(`create:${backup.dir}`)
			if (options.createFails) throw new Error("upload refused")
			return { id: "backup-2" }
		},
		restoreBackup: async (backup) => {
			calls.push(`restore:${backup.id}->${backup.dir}`)
		},
		readBackup: async () =>
			Option.fromNullishOr(store.get(MIRROR_BACKUP_KEY) as StoredMirrorBackup | undefined),
		writeBackup: async (backup) => {
			store.set(MIRROR_BACKUP_KEY, backup)
		},
		forgetBackup: async () => {
			store.delete(MIRROR_BACKUP_KEY)
		},
		now: () => NOW,
	}
}

const hoursAgo = (hours: number) => NOW - Duration.toMillis(Duration.hours(hours))

describe("restoreMirror", () => {
	it.effect("does nothing when backups are not configured", () =>
		Effect.gen(function* () {
			const host = fakeHost({ configured: false, stored: { id: "b", createdAt: hoursAgo(1) } })
			assert.strictEqual(yield* restoreMirror(host), "unconfigured")
			assert.deepStrictEqual(host.calls, [])
		}),
	)

	it.effect("does nothing when the repository was never backed up", () =>
		Effect.gen(function* () {
			const host = fakeHost({})
			assert.strictEqual(yield* restoreMirror(host), "none")
			assert.deepStrictEqual(host.calls, [])
		}),
	)

	it.effect("restores the last backup to the seed path of a cold container", () =>
		Effect.gen(function* () {
			const host = fakeHost({ stored: { id: "backup-1", createdAt: hoursAgo(30) }, exits: [1] })
			assert.strictEqual(yield* restoreMirror(host), "restored")
			assert.include(host.calls, `restore:backup-1->${SANDBOX_SEED_DIR}`)
		}),
	)

	it.effect("leaves a container that already has a mirror alone", () =>
		Effect.gen(function* () {
			const host = fakeHost({ stored: { id: "backup-1", createdAt: hoursAgo(1) }, exits: [0] })
			assert.strictEqual(yield* restoreMirror(host), "present")
			assert.isFalse(host.calls.some((call) => call.startsWith("restore:")))
		}),
	)

	it.effect("forgets a backup older than R2 keeps it", () =>
		Effect.gen(function* () {
			const expired = NOW - Duration.toMillis(MIRROR_BACKUP_TTL)
			const host = fakeHost({ stored: { id: "backup-1", createdAt: expired } })
			assert.strictEqual(yield* restoreMirror(host), "expired")
			assert.isFalse(host.store.has(MIRROR_BACKUP_KEY))
			assert.isFalse(host.calls.some((call) => call.startsWith("restore:")))
		}),
	)
})

describe("backupMirror", () => {
	it.effect("skips while the last backup is fresh", () =>
		Effect.gen(function* () {
			const fresh = NOW - Duration.toMillis(MIRROR_BACKUP_REFRESH) + 1
			const host = fakeHost({ stored: { id: "backup-1", createdAt: fresh } })
			assert.strictEqual(yield* backupMirror(host), "fresh")
			assert.deepStrictEqual(host.calls, [])
		}),
	)

	it.effect("archives the snapshot, never the live mirror, and stores the new handle", () =>
		Effect.gen(function* () {
			const host = fakeHost({ stored: { id: "backup-1", createdAt: hoursAgo(25) } })
			assert.strictEqual(yield* backupMirror(host), "created")
			assert.include(host.calls, `create:${SANDBOX_SNAPSHOT_DIR}`)
			assert.deepStrictEqual(
				host.store.get(MIRROR_BACKUP_KEY),
				new StoredMirrorBackup({ id: "backup-2", createdAt: NOW }),
			)
			// The snapshot is removed once archived.
			assert.include(host.calls.at(-1)!, `rm -rf ${shellQuote(SANDBOX_SNAPSHOT_DIR)}`)
		}),
	)

	it.effect("backs up a repository with no backup yet", () =>
		Effect.gen(function* () {
			const host = fakeHost({})
			assert.strictEqual(yield* backupMirror(host), "created")
		}),
	)

	it.effect("skips a container with no mirror yet", () =>
		Effect.gen(function* () {
			const host = fakeHost({ exits: [3] })
			assert.strictEqual(yield* backupMirror(host), "no-mirror")
			assert.isFalse(host.calls.some((call) => call.startsWith("create:")))
		}),
	)

	it.effect("keeps the previous handle and removes the snapshot when the upload fails", () =>
		Effect.gen(function* () {
			const previous = { id: "backup-1", createdAt: hoursAgo(25) }
			const host = fakeHost({ stored: previous, createFails: true })
			const exit = yield* Effect.exit(backupMirror(host))
			assert.isTrue(Exit.isFailure(exit))
			assert.deepStrictEqual(host.store.get(MIRROR_BACKUP_KEY), new StoredMirrorBackup(previous))
			assert.include(host.calls.at(-1)!, `rm -rf ${shellQuote(SANDBOX_SNAPSHOT_DIR)}`)
		}),
	)

	it.effect("does nothing when backups are not configured", () =>
		Effect.gen(function* () {
			const host = fakeHost({ configured: false })
			assert.strictEqual(yield* backupMirror(host), "unconfigured")
			assert.deepStrictEqual(host.calls, [])
		}),
	)
})
