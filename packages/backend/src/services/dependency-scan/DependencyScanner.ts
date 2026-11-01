import { EdgeCacheService } from "@maple/cache"
import type { DependencyScanRow } from "@maple/db/tables"
import { DependencyRelation, type DependencyScanLockfile } from "@maple/domain/dependency-scan"
import {
	type DependencyScanTrigger,
	type GitCommitSha,
	type UnknownVcsProviderError,
	type VcsInstallation,
	type VcsRepo,
	VcsRepositoryId,
	type VcsRepositoryRef,
} from "@maple/domain/http"
import { type PackageAdvisory, PackageEcosystem, packageKey } from "@maple/domain/package-advisories"
import { parseLockfile } from "@maple/lockfiles"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import type {
	VcsProviderClient,
	VcsTreeFile,
} from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { DependencyScanSink } from "@maple/backend/services/integrations/vcs/PullRequestEventSink"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { PackageAdvisoryCatalog } from "@maple/backend/services/security/PackageAdvisoryCatalog"
import { type DependencyScanMatchInput, DependencyScanStore } from "./DependencyScanStore"
import {
	MAX_LOCKFILES,
	manifestsFor,
	type SelectedLockfile,
	sameLockfiles,
	selectLockfiles,
} from "./lockfile-selection"

// Reads a repository's lockfiles at one commit through the VCS provider, looks their packages up
// in OSV and stores the scan. A lockfile's parse is cached by its blob sha (and its manifests'),
// so a rescan for new advisories reads nothing from the provider but the tree.

const PARSE_CACHE_BUCKET = "lockfile-packages"
const PARSE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
/** Larger lockfiles are recorded as too large rather than read into the Worker's memory. */
export const MAX_LOCKFILE_BYTES = 15 * 1024 * 1024
const READ_CONCURRENCY = 4

const LockedPackageRow = Schema.Struct({
	ecosystem: PackageEcosystem,
	name: Schema.String,
	version: Schema.String,
	relation: DependencyRelation,
})
type LockedPackageRow = typeof LockedPackageRow.Type

const CachedLockfile = Schema.Struct({
	packages: Schema.Array(LockedPackageRow),
	warnings: Schema.Array(Schema.String),
})

export class DependencyScanError extends Schema.TaggedError<DependencyScanError>()(
	"@maple/dependency-scan/DependencyScanError",
	{ message: Schema.String, repositoryId: VcsRepositoryId, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/**
 * What a failed scan records: a typed failure's message (exact, so a repeated failure is
 * recognised) with its underlying cause when it has one, an interruption, or a defect's summary.
 */
const failureText = (cause: Cause.Cause<DependencyScanError>): string =>
	Option.match(Cause.findErrorOption(cause), {
		onNone: () =>
			Cause.hasInterruptsOnly(cause)
				? "The scan was interrupted before it finished"
				: summarizeCause(cause),
		onSome: (error) =>
			error.cause instanceof Error && error.cause.message !== ""
				? `${error.message}: ${error.cause.message}`
				: error.message,
	})

export interface DependencyScanRequest {
	readonly trigger: DependencyScanTrigger
	/** Scan this commit instead of the tracked branch head; it then never reconciles findings. */
	readonly commitSha?: GitCommitSha | undefined
}

export type DependencyScanOutcome =
	| { readonly _tag: "Scanned"; readonly scan: DependencyScanRow }
	/** A push that left every lockfile as the last scan read it. */
	| { readonly _tag: "Unchanged" }
	/** The tracked branch has no commit yet. */
	| { readonly _tag: "EmptyRepository" }

export interface DependencyScannerApi {
	readonly scan: (
		installation: VcsInstallation,
		repository: VcsRepo,
		request: DependencyScanRequest,
	) => Effect.Effect<DependencyScanOutcome, DependencyScanError>
}

/** The provider reads a scan makes; the registry's clients have them, tests stub only these. */
export type DependencySource = Pick<VcsProviderClient, "resolveRef" | "fetchTreeFiles" | "fetchBlobText">

export class DependencySources extends Context.Service<
	DependencySources,
	{ readonly resolve: (provider: string) => Effect.Effect<DependencySource, UnknownVcsProviderError> }
>()("@maple/backend/services/dependency-scan/DependencySources") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const registry = yield* VcsProviderRegistry
			return { resolve: registry.resolve }
		}),
	).pipe(Layer.provide(VcsProviderRegistry.layer))
}

interface ReadLockfile {
	readonly lockfile: DependencyScanLockfile
	readonly packages: ReadonlyArray<LockedPackageRow>
}

export class DependencyScanner extends Context.Service<DependencyScanner, DependencyScannerApi>()(
	"@maple/backend/services/dependency-scan/DependencyScanner",
	{
		make: Effect.gen(function* () {
			const sources = yield* DependencySources
			const store = yield* DependencyScanStore
			const catalog = yield* PackageAdvisoryCatalog
			const edgeCache = yield* EdgeCacheService

			const lockfileRow = (
				selected: SelectedLockfile,
				status: DependencyScanLockfile["status"],
				packageCount: number,
				message: string | null,
			): DependencyScanLockfile => ({
				path: selected.file.path,
				kind: selected.kind,
				blobSha: selected.file.sha,
				packageCount,
				status,
				message,
			})

			/** Fetches and parses one lockfile; a format problem is the lockfile's status, a provider failure fails the scan. */
			const readLockfile = (
				provider: DependencySource,
				installation: VcsInstallation,
				repo: VcsRepositoryRef,
				selected: SelectedLockfile,
				tree: ReadonlyArray<VcsTreeFile>,
			) => {
				if (selected.file.size > MAX_LOCKFILE_BYTES)
					return Effect.succeed<ReadLockfile>({
						lockfile: lockfileRow(
							selected,
							"too_large",
							0,
							`${selected.file.size} bytes, over the ${MAX_LOCKFILE_BYTES} a scan reads`,
						),
						packages: [],
					})
				const manifests = manifestsFor(selected, tree)
				const read = Effect.gen(function* () {
					const content = yield* provider.fetchBlobText(installation, repo, selected.file.sha)
					const manifestTexts = yield* Effect.forEach(
						manifests,
						(manifest) =>
							provider
								.fetchBlobText(installation, repo, manifest.file.sha)
								.pipe(Effect.map((text) => [manifest.relativePath, text] as const)),
						{ concurrency: READ_CONCURRENCY },
					)
					const parsed = yield* parseLockfile({
						path: selected.file.path,
						content,
						manifests: new Map(manifestTexts),
					})
					return { packages: parsed.packages, warnings: parsed.warnings }
				})
				return edgeCache
					.getOrCompute(
						{
							bucket: PARSE_CACHE_BUCKET,
							key: [selected.file.sha, ...manifests.map((manifest) => manifest.file.sha)].join(
								":",
							),
							ttlSeconds: PARSE_CACHE_TTL_SECONDS,
							schema: CachedLockfile,
						},
						read,
					)
					.pipe(
						Effect.map(({ value }): ReadLockfile => ({
							lockfile: lockfileRow(
								selected,
								"parsed",
								value.packages.length,
								value.warnings.length === 0 ? null : value.warnings.join("; "),
							),
							packages: value.packages,
						})),
						Effect.catchTags({
							"@maple/lockfiles/LockfileParseError": (error) =>
								Effect.succeed<ReadLockfile>({
									lockfile: lockfileRow(selected, "failed", 0, error.message),
									packages: [],
								}),
							"@maple/lockfiles/LockfileUnsupportedError": (error) =>
								Effect.succeed<ReadLockfile>({
									lockfile: lockfileRow(selected, "unsupported", 0, error.message),
									packages: [],
								}),
						}),
						Effect.withSpan("DependencyScanner.readLockfile", {
							attributes: {
								"maple.depscan.lockfile.path": selected.file.path,
								"maple.depscan.lockfile.kind": selected.kind,
							},
						}),
					)
			}

			const matchesOf = (
				reads: ReadonlyArray<ReadLockfile>,
				advisories: ReadonlyMap<string, ReadonlyArray<PackageAdvisory>>,
			): ReadonlyArray<DependencyScanMatchInput> =>
				reads.flatMap(({ lockfile, packages }) =>
					packages.flatMap((pkg) =>
						(advisories.get(packageKey(pkg)) ?? []).map((advisory): DependencyScanMatchInput => ({
							lockfilePath: lockfile.path,
							ecosystem: pkg.ecosystem,
							packageName: pkg.name,
							version: pkg.version,
							relation: pkg.relation,
							advisoryId: advisory.id,
							aliases: advisory.aliases,
							severity: advisory.severity,
							summary: advisory.summary,
							fixedIn: advisory.fixedIn,
						})),
					),
				)

			const scan: DependencyScannerApi["scan"] = Effect.fn("DependencyScanner.scan")(
				function* (installation, repository, request) {
					const orgId = repository.orgId
					const ref = repository.trackedBranch ?? repository.defaultBranch
					const repo: VcsRepositoryRef = {
						externalRepoId: repository.externalRepoId,
						owner: repository.owner,
						name: repository.name,
					}
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repository.id,
						"maple.depscan.trigger": request.trigger,
					})
					const scanError = (message: string) => (cause: unknown) =>
						new DependencyScanError({ message, repositoryId: repository.id, cause })
					const provider = yield* sources
						.resolve(repository.provider)
						.pipe(Effect.mapError(scanError("Unknown VCS provider")))
					const headOpt =
						request.commitSha === undefined
							? yield* provider
									.resolveRef(installation, repo, ref)
									.pipe(Effect.mapError(scanError(`Could not resolve ${ref}`)))
							: Option.some(request.commitSha)
					if (Option.isNone(headOpt))
						return { _tag: "EmptyRepository" } satisfies DependencyScanOutcome
					const commitSha = headOpt.value
					const defaultBranchHead = request.commitSha === undefined
					const tree = yield* provider
						.fetchTreeFiles(installation, repo, commitSha)
						.pipe(Effect.mapError(scanError("Could not list the repository tree")))
					const { selected, skipped } = selectLockfiles(tree.files)
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.sha": commitSha,
						"maple.depscan.lockfile_count": selected.length,
						"maple.depscan.lockfiles_skipped": skipped.length,
						"maple.depscan.tree_truncated": tree.truncated,
					})

					// A yarn scan also reads package.json for direct and dev, which a lockfile sha does not cover.
					const readsManifests = selected.some(
						(lockfile) => lockfile.kind === "yarn-v1" || lockfile.kind === "yarn-berry",
					)
					if (request.trigger === "push" && !readsManifests) {
						const latest = yield* store
							.latestScan({ orgId, repositoryId: repository.id })
							.pipe(Effect.mapError(scanError("Could not read the last scan")))
						if (
							Option.isSome(latest) &&
							latest.value.defaultBranchHead &&
							!tree.truncated &&
							// Skipped lockfiles are on the last scan too, so they count toward "unchanged".
							sameLockfiles(latest.value.lockfiles, [...selected, ...skipped])
						) {
							yield* Effect.annotateCurrentSpan({ "maple.depscan.outcome": "unchanged" })
							return { _tag: "Unchanged" } satisfies DependencyScanOutcome
						}
					}

					const started = yield* store
						.startScan({
							orgId,
							repositoryId: repository.id,
							commitSha,
							ref: defaultBranchHead ? ref : null,
							trigger: request.trigger,
							defaultBranchHead,
						})
						.pipe(Effect.mapError(scanError("Could not record the scan")))
					yield* Effect.annotateCurrentSpan({ "maple.depscan.scan_id": started.id })

					const run = Effect.gen(function* () {
						// A cut-short listing would read as deleted lockfiles and mark their findings fixed.
						if (tree.truncated)
							return yield* new DependencyScanError({
								message: "The repository tree is too large to list in one read",
								repositoryId: repository.id,
							})
						const reads = yield* Effect.forEach(
							selected,
							(lockfile) =>
								readLockfile(provider, installation, repo, lockfile, tree.files).pipe(
									Effect.mapError(scanError(`Could not read ${lockfile.file.path}`)),
								),
							{ concurrency: READ_CONCURRENCY },
						)
						const packages = reads.flatMap((read) => read.packages)
						const advisories = yield* catalog
							.advisories(packages)
							.pipe(Effect.mapError(scanError("Could not read advisories")))
						const matches = matchesOf(reads, advisories)
						yield* Effect.annotateCurrentSpan({
							"maple.depscan.package_count": packages.length,
							"maple.depscan.match_count": matches.length,
						})
						// A branch that moved on while this scan read it gets a newer scan; this one must not
						// reconcile over it, whichever of the two settles last.
						const headNow = defaultBranchHead
							? yield* provider
									.resolveRef(installation, repo, ref)
									.pipe(Effect.mapError(scanError(`Could not resolve ${ref}`)))
							: Option.none()
						const movedTo = Option.filter(headNow, (sha) => sha !== commitSha)
						return yield* store
							.completeScan({
								orgId,
								scanId: started.id,
								incomplete: Option.match(movedTo, {
									onNone: () => undefined,
									onSome: (sha) => `${ref} moved on to ${sha.slice(0, 7)} during the scan`,
								}),
								// A lockfile past the cap is recorded, so its findings are kept rather than read as deleted.
								lockfiles: [
									...reads.map((read) => read.lockfile),
									...skipped.map((lockfile) =>
										lockfileRow(
											lockfile,
											"skipped",
											0,
											`Past the ${MAX_LOCKFILES} lockfiles a scan reads`,
										),
									),
								],
								packageCount: packages.length,
								matches,
							})
							.pipe(Effect.mapError(scanError("Could not store the scan")))
					})
					// Any end but success settles the row, an interruption or a defect included.
					const completed = yield* run.pipe(
						Effect.onError((cause) =>
							store
								.failScan({
									orgId,
									scanId: started.id,
									// A typed failure keeps its own message, which the next push compares against.
									error: failureText(cause),
								})
								.pipe(Effect.ignore),
						),
					)
					yield* Effect.annotateCurrentSpan({ "maple.depscan.outcome": "scanned" })
					return { _tag: "Scanned", scan: completed } satisfies DependencyScanOutcome
				},
			)

			return { scan } satisfies DependencyScannerApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(DependencyScanStore.layer, PackageAdvisoryCatalog.layer, DependencySources.layer),
		),
	)
}

/** Binds the VCS sync's scan requests to the scanner. A failed scan is recorded on its row and logged; the job stands. */
export const DependencyScanSinkLive = Layer.effect(
	DependencyScanSink,
	Effect.gen(function* () {
		const scanner = yield* DependencyScanner
		return {
			onScanRequested: (installation, repository, job) =>
				scanner
					.scan(installation, repository, { trigger: job.trigger, commitSha: job.commitSha })
					.pipe(
						Effect.asVoid,
						Effect.catchCause((cause) =>
							Effect.logWarning("[DependencyScan] scan failed").pipe(
								Effect.annotateLogs({
									orgId: repository.orgId,
									repository: repository.fullName,
									trigger: job.trigger,
									cause: summarizeCause(cause),
								}),
							),
						),
					),
		}
	}),
).pipe(Layer.provide(DependencyScanner.layer))
