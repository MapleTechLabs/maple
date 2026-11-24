import { EdgeCacheService } from "@maple/cache"
import type { DependencyScanRow } from "@maple/db/tables"
import {
	DependencyLockfileKind,
	DependencyRelation,
	type DependencyScanLockfile,
} from "@maple/domain/dependency-scan"
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
import { parseLockfile, unsupportedReason } from "@maple/lockfiles"
import {
	Cause,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Result,
	Schema,
	String as Str,
	Array as Arr,
} from "effect"
import type {
	VcsProviderClient,
	VcsTreeFile,
} from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { DependencyScanSink } from "@maple/backend/services/integrations/vcs/PullRequestEventSink"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import {
	type AdvisoryQuery,
	fingerprintOf,
	MAX_VULNERABILITIES,
	PackageAdvisoryCatalog,
} from "@maple/backend/services/security/PackageAdvisoryCatalog"
import { type DependencyScanMatchInput, DependencyScanStore } from "./DependencyScanStore"
import {
	MAX_LOCKFILES,
	MAX_MANIFEST_BYTES,
	MAX_SKIPPED_LOCKFILES,
	manifestsFor,
	type SelectedLockfile,
	sameLockfiles,
	selectLockfiles,
} from "./lockfile-selection"
import { RESCAN_AFTER_MS } from "./production"

// Reads a repository's lockfiles at one commit through the VCS provider, looks their packages up
// in OSV and stores the scan. A lockfile's parse is cached by its blob sha (and its manifests'),
// and a commit's lockfile selection by its sha, so a rescan for new advisories reads nothing from
// the provider. A scheduled rescan whose OSV answer is unchanged stores nothing.

const PARSE_CACHE_BUCKET = "lockfile-packages"
/** Part of the parse cache key: bump it when a parser fix should reach lockfiles already cached. */
const PARSER_VERSION = 4
const PARSE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
const PLAN_CACHE_BUCKET = "dependency-scan-plan"
/** Part of the plan cache key: bump it when lockfile or manifest selection changes. */
const PLAN_VERSION = 3
/** Larger lockfiles are recorded as too large rather than read into the Worker's memory. */
export const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024
/** Two lockfiles at a time keeps a monorepo's largest pair well inside a Worker's memory. */
const READ_CONCURRENCY = 2
const MANIFEST_CONCURRENCY = 4

const LockedPackageRow = Schema.Struct({
	ecosystem: PackageEcosystem,
	name: Schema.String,
	version: Schema.String,
	relation: DependencyRelation,
})
type LockedPackageRow = typeof LockedPackageRow.Type

/** A blob's parse, or why it has none: a broken lockfile fails the same way until it changes. */
const CachedLockfile = Schema.Union([
	Schema.TaggedStruct("Parsed", {
		packages: Schema.Array(LockedPackageRow),
		warnings: Schema.Array(Schema.String),
	}),
	Schema.TaggedStruct("Unreadable", {
		status: Schema.Literals(["failed", "unsupported"]),
		message: Schema.String,
	}),
])
type CachedLockfile = typeof CachedLockfile.Type

const PlannedFile = Schema.Struct({ path: Schema.String, sha: Schema.String, size: Schema.Number })
const PlannedLockfile = Schema.Struct({
	file: PlannedFile,
	kind: DependencyLockfileKind,
	/** The package.json files a yarn lockfile reads, keyed relative to its directory. */
	manifests: Schema.Array(Schema.Struct({ relativePath: Schema.String, file: PlannedFile })),
})
type PlannedLockfile = typeof PlannedLockfile.Type

/** Which files of one commit's tree a scan reads; a commit never changes, so it is cached by sha. */
const ScanPlan = Schema.Struct({
	selected: Schema.Array(PlannedLockfile),
	skipped: Schema.Array(PlannedLockfile),
	omitted: Schema.Number,
})
type ScanPlan = typeof ScanPlan.Type

const planOf = (files: ReadonlyArray<VcsTreeFile>): ScanPlan => {
	const { selected, skipped, omitted } = selectLockfiles(files)
	return {
		omitted,
		selected: Arr.map(selected, (lockfile) => ({
			...lockfile,
			manifests: manifestsFor(lockfile, files),
		})),
		skipped: Arr.map(skipped, (lockfile) => ({ ...lockfile, manifests: [] })),
	}
}

/** A commit's plan, or null when its tree is too large to list: a commit's tree never changes. */
const CachedPlan = Schema.NullOr(ScanPlan)

export class DependencyScanError extends Schema.TaggedError<DependencyScanError>()(
	"@maple/dependency-scan/DependencyScanError",
	{ message: Schema.String, repositoryId: VcsRepositoryId, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/**
 * What a failed scan records: a typed failure's message (exact, so a repeated failure is
 * recognised; it already names its cause), an interruption, or a defect's summary.
 */
const failureText = (cause: Cause.Cause<DependencyScanError>): string =>
	Option.match(Cause.findErrorOption(cause), {
		onNone: () =>
			Cause.hasInterruptsOnly(cause)
				? "The scan was interrupted before it finished"
				: summarizeCause(cause),
		onSome: (error) => error.message,
	})

export interface DependencyScanRequest {
	readonly trigger: DependencyScanTrigger
	/** Scan this commit instead of the tracked branch head; it then never reconciles findings. */
	readonly commitSha?: GitCommitSha | undefined
}

export type DependencyScanOutcome =
	| { readonly _tag: "Scanned"; readonly scan: DependencyScanRow }
	/** A push that left every lockfile as the last scan read it, or a commit already scanned. */
	| { readonly _tag: "Unchanged" }
	/** The tracked branch has no commit yet. */
	| { readonly _tag: "EmptyRepository" }
	/** The provider will not show the repository: blocked, gone, or the installation removed. */
	| { readonly _tag: "RepositoryUnreachable"; readonly reason: UnreachableReason }
	/** The tree is too large to list; the failed scan row says so. */
	| { readonly _tag: "TreeTooLarge"; readonly scan: DependencyScanRow }

type UnreachableReason = "blocked" | "unavailable" | "installation_gone"

const unreachable = (reason: UnreachableReason) => () =>
	Effect.succeed(Result.fail<UnreachableReason>(reason))

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

const TREE_TOO_LARGE = "The repository tree is too large to list, even directory by directory"

interface ReadLockfile {
	readonly lockfile: DependencyScanLockfile
	readonly packages: ReadonlyArray<LockedPackageRow>
}

/** What a scheduled precheck read, kept so a changed answer is scanned without reading it twice. */
interface Prepared {
	readonly plan: ScanPlan
	readonly reads: ReadonlyArray<ReadLockfile>
	readonly query: AdvisoryQuery
	readonly unchanged: boolean
}

const EMPTY_PLAN: ScanPlan = { selected: [], skipped: [], omitted: 0 }

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
				selected: PlannedLockfile,
			) => {
				const unsupported = unsupportedReason(selected.kind)
				if (unsupported !== undefined)
					return Effect.succeed<ReadLockfile>({
						lockfile: lockfileRow(selected, "unsupported", 0, unsupported),
						packages: [],
					})
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
				const manifests = selected.manifests
				const read = Effect.gen(function* () {
					const content = yield* provider.fetchBlobText(
						installation,
						repo,
						selected.file.sha,
						MAX_LOCKFILE_BYTES,
					)
					const manifestTexts = yield* Effect.forEach(
						manifests,
						(manifest) =>
							provider
								.fetchBlobText(installation, repo, manifest.file.sha, MAX_MANIFEST_BYTES)
								.pipe(Effect.map((text) => [manifest.relativePath, text] as const)),
						{ concurrency: MANIFEST_CONCURRENCY },
					)
					return yield* parseLockfile({
						path: selected.file.path,
						content,
						manifests: new Map(manifestTexts),
					}).pipe(
						Effect.map((parsed): CachedLockfile => ({
							_tag: "Parsed",
							packages: parsed.packages,
							warnings: parsed.warnings,
						})),
						Effect.catchTags({
							"@maple/lockfiles/LockfileParseError": (error) =>
								Effect.succeed<CachedLockfile>({
									_tag: "Unreadable",
									status: "failed",
									message: error.message,
								}),
							"@maple/lockfiles/LockfileUnsupportedError": (error) =>
								Effect.succeed<CachedLockfile>({
									_tag: "Unreadable",
									status: "unsupported",
									message: error.message,
								}),
						}),
					)
				})
				return edgeCache
					.getOrCompute(
						{
							bucket: PARSE_CACHE_BUCKET,
							key: Arr.join(
								[
									`v${PARSER_VERSION}`,
									// The same bytes can be valid for one format and broken for another.
									selected.kind,
									selected.file.sha,
									...Arr.map(manifests, (manifest) => manifest.file.sha),
								],
								":",
							),
							ttlSeconds: PARSE_CACHE_TTL_SECONDS,
							schema: CachedLockfile,
						},
						read,
					)
					.pipe(
						Effect.map(({ value }): ReadLockfile =>
							value._tag === "Unreadable"
								? {
										lockfile: lockfileRow(selected, value.status, 0, value.message),
										packages: [],
									}
								: {
										lockfile: lockfileRow(
											selected,
											"parsed",
											value.packages.length,
											value.warnings.length === 0
												? null
												: Arr.join(value.warnings, "; "),
										),
										packages: value.packages,
									},
						),
						Effect.tap((read) =>
							Effect.annotateCurrentSpan("maple.depscan.lockfile.status", read.lockfile.status),
						),
						Effect.withSpan("DependencyScanner.readLockfile", {
							attributes: {
								"maple.depscan.lockfile.path": selected.file.path,
								"maple.depscan.lockfile.kind": selected.kind,
							},
						}),
					)
			}

			/** The commit's plan, from the cache or the tree; none when the tree is too large to list. */
			const loadPlan = (
				provider: DependencySource,
				installation: VcsInstallation,
				repository: VcsRepo,
				repo: VcsRepositoryRef,
				commitSha: GitCommitSha,
			) =>
				edgeCache
					.getOrCompute(
						{
							bucket: PLAN_CACHE_BUCKET,
							key: Arr.join(
								[
									`v${PLAN_VERSION}`,
									repository.provider,
									repository.externalRepoId,
									commitSha,
								],
								":",
							),
							ttlSeconds: PARSE_CACHE_TTL_SECONDS,
							schema: CachedPlan,
						},
						provider
							.fetchTreeFiles(installation, repo, commitSha)
							.pipe(Effect.map((tree) => (tree.truncated ? null : planOf(tree.files)))),
					)
					.pipe(Effect.map(({ value }) => Option.fromNullOr(value)))

			const matchesOf = (
				reads: ReadonlyArray<ReadLockfile>,
				advisories: ReadonlyMap<string, ReadonlyArray<PackageAdvisory>>,
			): ReadonlyArray<DependencyScanMatchInput> =>
				Arr.flatMap(reads, ({ lockfile, packages }) =>
					Arr.flatMap(packages, (pkg) =>
						Arr.map(
							advisories.get(packageKey(pkg)) ?? [],
							(advisory): DependencyScanMatchInput => ({
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
							}),
						),
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
					// The cause goes in the message too: the span status and the error group show only the
					// message, and "Could not resolve main" hid every rate limit and blocked repository.
					const scanError = (message: string) => (cause: unknown) =>
						new DependencyScanError({
							message:
								cause instanceof Error && cause.message !== ""
									? `${message}: ${cause.message}`
									: message,
							repositoryId: repository.id,
							cause,
						})
					// A scan whose worker died stays `running`; each new scan of the repo settles those.
					const startedAt = yield* Clock.currentTimeMillis
					yield* store
						.failAbandonedScans({
							orgId,
							repositoryId: repository.id,
							startedBefore: startedAt - RESCAN_AFTER_MS,
						})
						.pipe(
							Effect.catchTag(
								"@maple/dependency-scan/DependencyScanPersistenceError",
								(error) =>
									Effect.logWarning(
										"Could not settle abandoned dependency scans",
										error.message,
									),
							),
						)
					const provider = yield* sources
						.resolve(repository.provider)
						.pipe(Effect.mapError(scanError("Could not use the repository's provider")))
					// A repository the provider refuses to show is an answer, not a failed scan.
					const resolved =
						request.commitSha === undefined
							? yield* provider.resolveRef(installation, repo, ref).pipe(
									Effect.map((head) => Result.succeed(head)),
									Effect.catchTags({
										"@maple/http/errors/VcsRepositoryBlockedError":
											unreachable("blocked"),
										"@maple/http/errors/VcsRepoUnavailableError":
											unreachable("unavailable"),
										"@maple/http/errors/VcsInstallationGoneError":
											unreachable("installation_gone"),
									}),
									Effect.mapError(scanError(`Could not resolve ${ref}`)),
								)
							: Result.succeed(Option.some(request.commitSha))
					if (Result.isFailure(resolved)) {
						yield* Effect.annotateCurrentSpan({
							"maple.depscan.outcome": "repository_unreachable",
							"maple.depscan.skip_reason": resolved.failure,
						})
						return {
							_tag: "RepositoryUnreachable",
							reason: resolved.failure,
						} satisfies DependencyScanOutcome
					}
					const headOpt = resolved.success
					if (Option.isNone(headOpt))
						return { _tag: "EmptyRepository" } satisfies DependencyScanOutcome
					const commitSha = headOpt.value
					const defaultBranchHead = request.commitSha === undefined
					// A commit's content never changes: one scanned, or being scanned, is not read again.
					if (request.commitSha !== undefined) {
						const now = yield* Clock.currentTimeMillis
						const scans = yield* store
							.scansAtCommits({
								orgId,
								repositoryIds: [repository.id],
								commitShas: [commitSha],
							})
							.pipe(Effect.mapError(scanError("Could not read the last scan")))
						const covered = Arr.some(
							scans,
							(scan) =>
								scan.status === "completed" ||
								(scan.status === "running" && now - scan.startedAt <= RESCAN_AFTER_MS),
						)
						if (covered) return { _tag: "Unchanged" } satisfies DependencyScanOutcome
					}

					const readAll = (plan: ScanPlan) =>
						Effect.forEach(
							plan.selected,
							(lockfile) =>
								readLockfile(provider, installation, repo, lockfile).pipe(
									Effect.mapError(scanError(`Could not read ${lockfile.file.path}`)),
								),
							{ concurrency: READ_CONCURRENCY },
						)
					const planFor = loadPlan(provider, installation, repository, repo, commitSha).pipe(
						Effect.mapError(scanError("Could not list the repository tree")),
					)

					// A scheduled rescan of the commit its last complete scan read differs only by what OSV
					// says now. OSV is still asked; an unchanged answer means unchanged matches and findings.
					const precheck =
						request.trigger === "schedule" && defaultBranchHead
							? yield* Effect.gen(function* () {
									const latest = yield* store
										.latestScan({
											orgId,
											repositoryId: repository.id,
											defaultBranchHead: true,
											// A newer failed scan is what the repository shows; only a full scan clears it.
											anyStatus: true,
										})
										.pipe(Effect.mapError(scanError("Could not read the last scan")))
									if (
										Option.isNone(latest) ||
										latest.value.status !== "completed" ||
										latest.value.commitSha !== commitSha ||
										latest.value.error !== null ||
										latest.value.advisoryFingerprint === null
									)
										return Option.none<Prepared>()
									const fingerprint = latest.value.advisoryFingerprint
									const plan = yield* planFor
									if (Option.isNone(plan)) return Option.none<Prepared>()
									const reads = yield* readAll(plan.value)
									const query = yield* catalog
										.query(Arr.flatMap(reads, (read) => read.packages))
										.pipe(Effect.mapError(scanError("Could not read advisories")))
									return Option.some<Prepared>({
										plan: plan.value,
										reads,
										query,
										unchanged: fingerprintOf(query, PARSER_VERSION) === fingerprint,
									})
								}).pipe(
									// The full scan reads again and records the failure on its row.
									Effect.catchTag("@maple/dependency-scan/DependencyScanError", (error) =>
										Effect.logWarning(
											"Scheduled scan precheck failed",
											error.message,
										).pipe(Effect.as(Option.none<Prepared>())),
									),
								)
							: Option.none<Prepared>()
					if (Option.isSome(precheck) && precheck.value.unchanged) {
						const { plan } = precheck.value
						yield* Effect.annotateCurrentSpan({
							"vcs.commit.sha": commitSha,
							"maple.depscan.lockfile_count": plan.selected.length,
							"maple.depscan.lockfiles_skipped": plan.skipped.length,
							"maple.depscan.package_count": precheck.value.query.packages.length,
							"maple.depscan.outcome": "unchanged",
							"maple.depscan.skip_reason":
								plan.selected.length === 0 ? "no_lockfiles" : "advisories_unchanged",
						})
						return { _tag: "Unchanged" } satisfies DependencyScanOutcome
					}

					const planOpt = Option.isSome(precheck)
						? Option.some(precheck.value.plan)
						: yield* planFor
					const truncated = Option.isNone(planOpt)
					const { selected, skipped, omitted } = Option.getOrElse(
						planOpt,
						(): ScanPlan => EMPTY_PLAN,
					)
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.sha": commitSha,
						"maple.depscan.lockfile_count": selected.length,
						"maple.depscan.lockfiles_skipped": skipped.length + omitted,
						"maple.depscan.tree_truncated": truncated,
					})

					// A yarn scan also reads package.json for direct and dev, which a lockfile sha does not cover.
					const readsManifests = Arr.some(
						selected,
						(lockfile) => lockfile.kind === "yarn-v1" || lockfile.kind === "yarn-berry",
					)
					if (request.trigger === "push" && !readsManifests) {
						const latest = yield* store
							.latestScan({ orgId, repositoryId: repository.id, defaultBranchHead: true })
							.pipe(Effect.mapError(scanError("Could not read the last scan")))
						if (
							Option.isSome(latest) &&
							// An incomplete scan never reconciled, so its findings are not current.
							latest.value.error === null &&
							!truncated &&
							// Lockfiles past the record cap are not on the last scan, so it cannot match.
							omitted === 0 &&
							// Skipped lockfiles are on the last scan too, so they count toward "unchanged".
							sameLockfiles(latest.value.lockfiles, [...selected, ...skipped])
						) {
							yield* Effect.annotateCurrentSpan({ "maple.depscan.outcome": "unchanged" })
							return { _tag: "Unchanged" } satisfies DependencyScanOutcome
						}
					}

					// A tree too large to list fails the same way on every push; record it once. A production
					// scan of a commit records its own failure, which is retried after a while.
					// Pushes only: a manual or scheduled scan records its own result, so Scan now sees one.
					if (truncated && request.trigger === "push") {
						const scans = yield* store
							.latestBranchScans({ orgId })
							.pipe(Effect.mapError(scanError("Could not read the last scan")))
						const last = Option.getOrUndefined(
							Arr.findFirst(scans, (scan) => scan.repositoryId === repository.id),
						)
						if (last !== undefined && last.status === "failed" && last.error === TREE_TOO_LARGE)
							return { _tag: "Unchanged" } satisfies DependencyScanOutcome
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

					// A cut-short listing would read as deleted lockfiles and mark their findings fixed, so the
					// scan is recorded as failed. A known limit, not a fault: the span stays Ok.
					if (truncated) {
						const failed = yield* store
							.failScan({ orgId, scanId: started.id, error: TREE_TOO_LARGE })
							.pipe(Effect.mapError(scanError("Could not record the scan")))
						yield* Effect.annotateCurrentSpan({ "maple.depscan.outcome": "tree_too_large" })
						return { _tag: "TreeTooLarge", scan: failed } satisfies DependencyScanOutcome
					}

					const run = Effect.gen(function* () {
						// A scheduled precheck already asked OSV; its answer is reused, not asked for again.
						const reads = Option.isSome(precheck)
							? precheck.value.reads
							: yield* readAll({ selected, skipped, omitted })
						const packages = Arr.flatMap(reads, (read) => read.packages)
						const query = Option.isSome(precheck)
							? precheck.value.query
							: yield* catalog
									.query(packages)
									.pipe(Effect.mapError(scanError("Could not read advisories")))
						const advisories = yield* catalog
							.resolve(query)
							.pipe(Effect.mapError(scanError("Could not read advisories")))
						const matches = matchesOf(reads, advisories.byPackage)
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
						// Only the same SHA proves the head unchanged: a deleted branch is no head either.
						const headChange = !defaultBranchHead
							? undefined
							: Option.match(headNow, {
									onNone: () => `${ref} was deleted during the scan`,
									onSome: (sha) =>
										sha === commitSha
											? undefined
											: `${ref} moved on to ${Str.slice(0, 7)(sha)} during the scan`,
								})
						return yield* store
							.completeScan({
								orgId,
								scanId: started.id,
								lockfiles: [
									...Arr.map(reads, (read) => read.lockfile),
									...Arr.map(skipped, (lockfile) =>
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
								advisoryFingerprint: fingerprintOf(query, PARSER_VERSION),
								// Any reason keeps this scan from reconciling: the branch changed, lockfiles went
								// unrecorded, or advisories were left unread.
								incomplete:
									headChange ??
									(omitted === 0
										? undefined
										: `${omitted} lockfiles past the ${MAX_LOCKFILES + MAX_SKIPPED_LOCKFILES} a scan records were left out`) ??
									(advisories.unread === 0
										? undefined
										: `${advisories.unread} known vulnerabilities past the ${MAX_VULNERABILITIES} a scan reads were left out`),
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
						// The scan row records the failure; a defect still fails the job so it shows.
						Effect.catch((error) =>
							Effect.logWarning("[DependencyScan] scan failed").pipe(
								Effect.annotateLogs({
									orgId: repository.orgId,
									repository: repository.fullName,
									trigger: job.trigger,
									error: error.message,
								}),
							),
						),
					),
		}
	}),
).pipe(Layer.provide(DependencyScanner.layer))
