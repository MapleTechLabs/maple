// Acquire the pinned libchdb the way scripts/build-local-binary.sh does for the
// `maple` bundle: download the release asset, verify its sha256 BEFORE
// extracting (release assets are mutable even for a fixed tag), extract, and
// install it. Hosts without a bundled library (the @maple-dev/alchemy sidecar)
// keep one verified copy per release in a per-user cache.
import { Duration, Effect, Schedule, Schema } from "effect"
import { HttpClient } from "effect/http"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import manifest from "../libchdb.json" with { type: "json" }

export class LibchdbProvisionError extends Schema.TaggedError<LibchdbProvisionError>()(
	"@maple/local-server/LibchdbProvisionError",
	{ message: Schema.String },
) {}

export interface LibchdbRelease {
	readonly version: string
	/** sha256 of each platform's release asset, by asset file name. */
	readonly sha256: Readonly<Record<string, string>>
}

/** The release `maple` ships with and the sidecar build pins (`libchdb.json`). */
export const PINNED_LIBCHDB: LibchdbRelease = manifest

const RELEASES_URL = "https://github.com/chdb-io/chdb-core/releases/download"

/** Release asset per `${process.platform}-${process.arch}`, as the binary build names them. */
const PLATFORM_ASSETS = {
	"darwin-arm64": "macos-arm64-libchdb.tar.gz",
	"darwin-x64": "macos-x86_64-libchdb.tar.gz",
	"linux-arm64": "linux-aarch64-libchdb.tar.gz",
	"linux-x64": "linux-x86_64-libchdb.tar.gz",
} as const

const isSupportedPlatform = (key: string): key is keyof typeof PLATFORM_ASSETS =>
	Object.hasOwn(PLATFORM_ASSETS, key)

/** The release asset this machine needs, or `undefined` where chdb-core ships none. */
export const platformLibchdbAsset = (): string | undefined => {
	const platform = `${process.platform}-${process.arch}`
	return isSupportedPlatform(platform) ? PLATFORM_ASSETS[platform] : undefined
}

/** One verified copy per release, shared by every project on the machine (~330 MB). */
export const defaultLibchdbCacheRoot = (): string => join(homedir(), ".maple", "cache", "libchdb")

export interface ProvisionOptions {
	readonly cacheRoot?: string
	readonly release?: LibchdbRelease
	/** Base of `<baseUrl>/<version>/<asset>`; defaults to chdb-core's GitHub releases. */
	readonly baseUrl?: string
}

export interface ProvisionedLibchdb {
	readonly path: string
	readonly version: string
	/** Whether this call downloaded it (false: already cached). */
	readonly downloaded: boolean
}

const fail = (message: string) => new LibchdbProvisionError({ message })

/** Internal: a failure worth retrying (5xx or network); never escapes {@link download}. */
class RetryableDownload extends Schema.TaggedError<RetryableDownload>()(
	"@maple/local-server/RetryableDownload",
	{ message: Schema.String },
) {}

/** Release downloads 500 intermittently: retry 5xx and network failures, never a 404. */
const download = (url: string): Effect.Effect<ArrayBuffer, LibchdbProvisionError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const retryable = (detail: string) => new RetryableDownload({ message: `${url}: ${detail}` })
		const client = yield* HttpClient.HttpClient
		const response = yield* client.get(url).pipe(Effect.mapError((error) => retryable(error.message)))
		if (response.status >= 500) return yield* retryable(`HTTP ${response.status}`)
		if (response.status < 200 || response.status >= 300)
			return yield* fail(`${url}: HTTP ${response.status}`)
		return yield* response.arrayBuffer.pipe(Effect.mapError((error) => retryable(error.message)))
	}).pipe(
		Effect.retry({
			schedule: Schedule.spaced(Duration.seconds(5)),
			times: 5,
			while: (error) => error._tag === "@maple/local-server/RetryableDownload",
		}),
		Effect.catchTag("@maple/local-server/RetryableDownload", (error) => Effect.fail(fail(error.message))),
	)

const findLibrary = (root: string) =>
	Effect.tryPromise({
		try: () => readdir(root, { recursive: true }),
		catch: (error) => fail(`cannot list the extracted archive: ${String(error)}`),
	}).pipe(
		Effect.map((entries) =>
			entries.find((entry) => entry.endsWith("libchdb.so") || entry.endsWith("libchdb.dylib")),
		),
	)

/**
 * The path of a verified copy of the pinned libchdb for this platform,
 * downloading it into the cache on first use. Concurrent callers each stage in
 * their own directory and install with an atomic rename.
 */
export const provisionLibchdb = (options: ProvisionOptions = {}) =>
	Effect.gen(function* () {
		const release = options.release ?? PINNED_LIBCHDB
		const asset = platformLibchdbAsset()
		if (asset === undefined)
			return yield* fail(`no libchdb release asset for ${process.platform}-${process.arch}`)
		const expected = release.sha256[asset]
		if (expected === undefined)
			return yield* fail(`no pinned sha256 for ${asset} at libchdb ${release.version}`)

		const cacheRoot = options.cacheRoot ?? defaultLibchdbCacheRoot()
		const installDir = join(cacheRoot, release.version, asset.replace(/\.tar\.gz$/, ""))
		const target = join(installDir, "libchdb.so")
		if (existsSync(target)) return { path: target, version: release.version, downloaded: false }

		const url = `${options.baseUrl ?? RELEASES_URL}/${release.version}/${asset}`
		yield* Effect.logInfo(`downloading libchdb ${release.version} (${asset}) into ${installDir}`)
		const archive = yield* download(url)
		const actual = createHash("sha256").update(new Uint8Array(archive)).digest("hex")
		if (actual !== expected)
			return yield* fail(`libchdb checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)

		// Staged beside the cache so the final rename never crosses filesystems.
		const staging = join(cacheRoot, `.staging-${randomUUID()}`)
		yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () => mkdir(staging, { recursive: true }),
				catch: (error) => fail(`cannot create ${staging}: ${String(error)}`),
			}),
			() => Effect.promise(() => rm(staging, { recursive: true, force: true })),
		)
		const tarball = join(staging, asset)
		yield* Effect.tryPromise({
			try: () => writeFile(tarball, new Uint8Array(archive)),
			catch: (error) => fail(`cannot write ${tarball}: ${String(error)}`),
		})
		const exitCode = yield* Effect.tryPromise({
			try: () => Bun.spawn(["tar", "-xzf", tarball, "-C", staging], { stderr: "ignore" }).exited,
			catch: (error) => fail(`cannot run tar: ${String(error)}`),
		})
		if (exitCode !== 0) return yield* fail(`tar could not extract ${asset} (exit ${exitCode})`)
		const library = yield* findLibrary(staging)
		if (library === undefined) return yield* fail(`libchdb not found in ${asset}`)
		yield* Effect.tryPromise({
			try: async () => {
				await mkdir(installDir, { recursive: true })
				await rename(join(staging, library), target)
			},
			catch: (error) => fail(`cannot install libchdb into ${installDir}: ${String(error)}`),
		})
		return { path: target, version: release.version, downloaded: true }
	}).pipe(Effect.scoped)
