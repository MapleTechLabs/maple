import type { DependencyFindingRow, DependencyScanMatchRow, DependencyScanRow } from "@maple/db/tables"
import type { DependencyFindingId } from "@maple/domain/dependency-scan"
import {
	DependencyFindingNotFoundError,
	type DependencyFindingsResponse,
	type DependencyFindingUpdateRequest,
	type DependencyFindingView,
	DependencyScanPersistenceError,
	type DependencyScanRepositoriesResponse,
	DependencyScanRepositoryNotFoundError,
	type DependencyScanSummary,
	type DependencyRunningCommit,
	type DependencyRunningService,
	GitCommitSha,
	isInstallationProcessable,
	type VcsInstallation,
	type VcsRepo,
	type VcsRepositoryId,
	type VcsSyncJob,
} from "@maple/domain/http"
import type { OrgId, UserId } from "@maple/domain/primitives"
import type { DependencyFindingStatus } from "@maple/domain/dependency-scan"
import { EdgeCacheService } from "@maple/cache"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { VcsSyncQueue } from "@maple/backend/services/integrations/vcs/VcsSyncQueue"
import { DependencyScanStore } from "./DependencyScanStore"
import {
	findingKey,
	latestCompletedPerCommit,
	latestScanPerCommit,
	needsScan,
	productionByFinding,
	type RunningService,
	riskScore,
	scanAt,
} from "./production"

// The Dependencies tab's reads and writes: repositories with their latest scan, findings with
// their repository named, triage, and "scan now", which goes through the VCS sync queue.

/** Findings returned per read; the table sorts worst first, so the cut drops the least severe. */
export const FINDINGS_LIMIT = 500
/** Findings read before ranking, so a deployed older finding is not cut before its traffic counts. */
const FINDINGS_CANDIDATES = 2000
/** Production is what services served over the last day. */
const RUNNING_WINDOW_MS = 24 * 60 * 60 * 1000
/** Unscanned running commits queued per read, busiest first; the next read queues more. */
export const PRODUCTION_SCANS_PER_READ = 10

export type RunningCommitRow = typeof CH.runningCommitsRowSchema.Type
const RunningCommitRows = Schema.Array(CH.runningCommitsRowSchema)
const RUNNING_COMMITS_CACHE_BUCKET = "dependency-running-commits"
/** Running commits move with deploys, not by the second: one warehouse read per org a minute. */
const RUNNING_COMMITS_CACHE_MS = 60_000

export class RunningCommitsReadError extends Schema.TaggedError<RunningCommitsReadError>()(
	"@maple/dependency-scan/RunningCommitsReadError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** Which commit each service served traffic from in a window, busiest first. */
export class RunningCommits extends Context.Service<
	RunningCommits,
	{
		readonly read: (
			tenant: TenantContext,
			window: { readonly startMs: number; readonly endMs: number },
		) => Effect.Effect<ReadonlyArray<RunningCommitRow>, RunningCommitsReadError>
	}
>()("@maple/backend/services/dependency-scan/RunningCommits") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService
			const edgeCache = yield* EdgeCacheService
			return {
				// The tab's two reads land together: the first reads the warehouse, the second the cache.
				read: (tenant, window) =>
					edgeCache
						.getOrCompute(
							{
								bucket: RUNNING_COMMITS_CACHE_BUCKET,
								key: `${tenant.orgId}:${Math.floor(window.endMs / RUNNING_COMMITS_CACHE_MS)}`,
								ttlSeconds: (2 * RUNNING_COMMITS_CACHE_MS) / 1000,
								schema: RunningCommitRows,
							},
							warehouse.compiledQuery(
								tenant,
								CH.compile(
									CH.runningCommitsQuery(),
									{
										orgId: tenant.orgId,
										startTime: formatWarehouseDateTime(window.startMs),
										endTime: formatWarehouseDateTime(window.endMs),
									},
									{ rowSchema: CH.runningCommitsRowSchema },
								),
								{ profile: "list", context: "dependencyRunningCommits" },
							),
						)
						.pipe(
							Effect.map((result) => result.value),
							Effect.mapError(
								(cause) =>
									new RunningCommitsReadError({
										message: "Could not read running commits",
										cause,
									}),
							),
						),
			}
		}),
	).pipe(Layer.provide(WarehouseQueryService.layer))
}

export interface Connected {
	readonly installation: VcsInstallation
	readonly repository: VcsRepo
}

interface Production {
	readonly available: boolean
	/** Running (service, environment, commit) rows whose commit belongs to a connected repository. */
	readonly running: ReadonlyArray<RunningService>
	/** Distinct services reporting a commit. */
	readonly runningServices: number
	/** False when the read hit its row cap, so commits past it are unknown. */
	readonly complete: boolean
	/** Latest scan per running commit, any status: what the repository list shows. */
	readonly latest: ReadonlyMap<string, DependencyScanRow>
	/** The matches of each running commit's latest completed scan. */
	readonly matches: ReadonlyArray<DependencyScanMatchRow>
	readonly completed: ReadonlyMap<string, DependencyScanRow>
}

const NO_PRODUCTION: Production = {
	available: false,
	complete: false,
	running: [],
	runningServices: 0,
	latest: new Map(),
	matches: [],
	completed: new Map(),
}

const distinctServices = (services: ReadonlyArray<{ readonly serviceName: string }>): number =>
	new Set(services.map((service) => service.serviceName)).size

const decodeSha = Schema.decodeUnknownOption(GitCommitSha)

const toRunningService = (service: RunningService): DependencyRunningService => ({
	serviceName: service.serviceName,
	environment: service.environment,
	commitSha: service.commitSha,
	spanCount: service.spanCount,
})

export interface DependencyScanServiceApi {
	/** Each repository with its latest scan and the commits services run from it. */
	readonly listRepositories: (
		tenant: TenantContext,
	) => Effect.Effect<DependencyScanRepositoriesResponse, DependencyScanPersistenceError>
	readonly requestScan: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
	) => Effect.Effect<
		{ readonly queued: boolean },
		DependencyScanPersistenceError | DependencyScanRepositoryNotFoundError
	>
	/** Most urgent first; production comes from telemetry and is left out when it cannot be read. */
	readonly listFindings: (
		tenant: TenantContext,
		query: {
			readonly status?: DependencyFindingStatus | undefined
			readonly repositoryId?: VcsRepositoryId | undefined
		},
	) => Effect.Effect<DependencyFindingsResponse, DependencyScanPersistenceError>
	readonly updateFinding: (
		orgId: OrgId,
		actor: UserId,
		findingId: DependencyFindingId,
		request: DependencyFindingUpdateRequest,
	) => Effect.Effect<DependencyFindingView, DependencyScanPersistenceError | DependencyFindingNotFoundError>
}

const persistence =
	(message: string) =>
	(error: { readonly _tag: string; readonly message: string }): DependencyScanPersistenceError =>
		new DependencyScanPersistenceError({ message: `${message}: ${error.message}`, cause: error._tag })

export const scanSummaryOf = (row: DependencyScanRow): DependencyScanSummary => ({
	id: row.id,
	commitSha: row.commitSha,
	ref: row.ref,
	trigger: row.trigger,
	status: row.status,
	lockfiles: row.lockfiles,
	packageCount: row.packageCount,
	vulnerableCount: row.vulnerableCount,
	error: row.error,
	startedAt: row.startedAt,
	finishedAt: row.finishedAt,
})

export const findingViewOf = (
	row: DependencyFindingRow,
	repositoryFullName: string,
	production: ReadonlyArray<DependencyRunningService>,
): DependencyFindingView => ({
	production,
	id: row.id,
	repositoryId: row.repositoryId,
	repositoryFullName,
	lockfilePath: row.lockfilePath,
	ecosystem: row.ecosystem,
	packageName: row.packageName,
	advisoryId: row.advisoryId,
	aliases: row.aliases,
	severity: row.severity,
	summary: row.summary,
	versions: row.versions,
	fixedIn: row.fixedIn,
	relation: row.relation,
	status: row.status,
	firstSeenScanId: row.firstSeenScanId,
	lastSeenScanId: row.lastSeenScanId,
	firstSeenSha: row.firstSeenSha,
	lastSeenSha: row.lastSeenSha,
	fixedScanId: row.fixedScanId,
	fixedSha: row.fixedSha,
	statusReason: row.statusReason,
	statusChangedBy: row.statusChangedBy,
	statusChangedAt: row.statusChangedAt,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

export interface DependencyScanReaderApi {
	/** The org's repositories under a processable installation, active ones only. */
	readonly connectedRepositories: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<Connected>, DependencyScanPersistenceError>
	/**
	 * Each repository with its latest scan and the commits services run from it, plus the scans
	 * those running commits still need. Queueing them is the caller's: a reader has no queue.
	 */
	readonly listRepositories: (tenant: TenantContext) => Effect.Effect<
		{
			readonly repositories: DependencyScanRepositoriesResponse
			readonly productionScans: ReadonlyArray<VcsSyncJob>
		},
		DependencyScanPersistenceError
	>
	readonly listFindings: DependencyScanServiceApi["listFindings"]
	/**
	 * One finding by id with the services running it, past the list's cap; None when its repository is
	 * gone. `productionKnown` is false when telemetry could not be read, so no services means unknown.
	 */
	readonly getFinding: (
		tenant: TenantContext,
		id: DependencyFindingId,
	) => Effect.Effect<
		Option.Option<{ readonly finding: DependencyFindingView; readonly productionKnown: boolean }>,
		DependencyScanPersistenceError
	>
}

/** The Dependencies tab's reads, without the VCS sync queue, so a Worker without it can read findings. */
export class DependencyScanReader extends Context.Service<DependencyScanReader, DependencyScanReaderApi>()(
	"@maple/backend/services/dependency-scan/DependencyScanReader",
	{
		make: Effect.gen(function* () {
			const store = yield* DependencyScanStore
			const vcs = yield* VcsRepository
			const runningCommits = yield* RunningCommits

			/** The org's repositories under a processable installation, active ones only. */
			const connectedRepositories = Effect.fn("DependencyScanReader.connectedRepositories")(
				function* (orgId: OrgId) {
					const installations = (yield* vcs.listInstallationsByOrg(orgId)).filter(
						isInstallationProcessable,
					)
					const repositories = yield* Effect.forEach(installations, (installation) =>
						vcs
							.listRepositoriesByInstallation(installation.id, "active")
							.pipe(
								Effect.map((list) =>
									list.map((repository): Connected => ({ installation, repository })),
								),
							),
					)
					return repositories.flat()
				},
				Effect.mapError(persistence("Could not list repositories")),
			)

			/** A scan job for each running commit that needs one, busiest first and capped. */
			const productionScanJobs = (
				connected: ReadonlyArray<Connected>,
				production: Production,
				now: number,
			): ReadonlyArray<VcsSyncJob> => {
				// Rows come busiest first, so a commit's first row is its busiest.
				const unscanned = production.running
					.filter((service) => needsScan(production.latest, service, now))
					.filter(
						(service, index, all) =>
							all.findIndex(
								(other) =>
									other.repositoryId === service.repositoryId &&
									other.commitSha === service.commitSha,
							) === index,
					)
					.slice(0, PRODUCTION_SCANS_PER_READ)
				return unscanned.flatMap((service): ReadonlyArray<VcsSyncJob> => {
					const owner = connected.find((entry) => entry.repository.id === service.repositoryId)
					return owner === undefined
						? []
						: [
								{
									kind: "dependency-scan",
									provider: owner.repository.provider,
									externalInstallationId: owner.installation.externalInstallationId,
									externalRepoId: owner.repository.externalRepoId,
									trigger: "production",
									commitSha: service.commitSha,
								},
							]
				})
			}

			/** The commits services ran over the last day, joined to connected repositories and their scans. */
			const readProduction = Effect.fn("DependencyScanReader.readProduction")(function* (
				tenant: TenantContext,
				connected: ReadonlyArray<Connected>,
			) {
				const now = yield* Clock.currentTimeMillis
				const rows = yield* runningCommits.read(tenant, {
					startMs: now - RUNNING_WINDOW_MS,
					endMs: now,
				})
				const withSha = rows.flatMap((row) =>
					Option.match(decodeSha(row.commitSha), {
						onNone: () => [],
						onSome: (sha) => [{ ...row, sha }],
					}),
				)
				const connectedIds = new Set(connected.map((entry) => entry.repository.id))
				const commits = yield* vcs.findCommitsByShas(
					tenant.orgId,
					withSha.map((row) => row.sha),
				)
				// A commit in two connected repositories (a fork, a mirror) cannot say which one a service
				// was built from, so it stays unlinked rather than credited to either.
				const linked = commits.filter((commit) => connectedIds.has(commit.repositoryId))
				const owners = linked.reduce((acc, commit) => {
					acc.set(commit.sha, new Set([...(acc.get(commit.sha) ?? []), commit.repositoryId]))
					return acc
				}, new Map<string, ReadonlySet<VcsRepositoryId>>())
				const repositoryOf = new Map(
					[...owners].flatMap(([sha, ids]) =>
						ids.size === 1 ? [[sha, [...ids][0]] as const] : [],
					),
				)
				const running = withSha.flatMap((row): ReadonlyArray<RunningService> => {
					const repositoryId = repositoryOf.get(row.sha)
					return repositoryId === undefined
						? []
						: [
								{
									repositoryId,
									commitSha: row.sha,
									serviceName: row.serviceName,
									environment: row.environment,
									spanCount: row.spanCount,
								},
							]
				})
				const scans = yield* store.scansAtCommits({
					orgId: tenant.orgId,
					repositoryIds: running.map((service) => service.repositoryId),
					commitShas: running.map((service) => service.commitSha),
				})
				const completed = latestCompletedPerCommit(scans)
				const matches = yield* store.matchesOfScans({
					orgId: tenant.orgId,
					scanIds: [...completed.values()].map((scan) => scan.id),
				})
				const production: Production = {
					available: true,
					running,
					runningServices: distinctServices(rows),
					complete: rows.length < CH.RUNNING_COMMITS_CAP,
					latest: latestScanPerCommit(scans),
					matches,
					completed,
				}
				yield* Effect.annotateCurrentSpan({
					"maple.depscan.running_services": production.runningServices,
					"maple.depscan.linked_services": distinctServices(running),
				})
				return production
			})

			/** Production when telemetry and the scans can be read; the tab still lists findings without it. */
			const productionOrNone = (tenant: TenantContext, connected: ReadonlyArray<Connected>) =>
				readProduction(tenant, connected).pipe(
					Effect.catch((error) =>
						Effect.logWarning("[DependencyScan] production read failed").pipe(
							Effect.annotateLogs({ orgId: tenant.orgId, error: error.message }),
							Effect.as(NO_PRODUCTION),
						),
					),
				)

			const listRepositories: DependencyScanReaderApi["listRepositories"] = Effect.fn(
				"DependencyScanReader.listRepositories",
			)(function* (tenant) {
				const orgId = tenant.orgId
				const connected = yield* connectedRepositories(orgId)
				const branchScans = yield* store
					.latestBranchScans({ orgId })
					.pipe(Effect.mapError(persistence("Could not list scans")))
				const latest = new Map(branchScans.map((scan) => [scan.repositoryId, scan]))
				const production = yield* productionOrNone(tenant, connected)
				const now = yield* Clock.currentTimeMillis
				const runningCommitsOf = (
					repositoryId: VcsRepositoryId,
				): ReadonlyArray<DependencyRunningCommit> => {
					const services = production.running.filter(
						(service) => service.repositoryId === repositoryId,
					)
					const shas = [...new Set(services.map((service) => service.commitSha))]
					return shas.map((commitSha) => ({
						commitSha,
						scanStatus: scanAt(production.latest, { repositoryId, commitSha })?.status ?? null,
						services: services
							.filter((service) => service.commitSha === commitSha)
							.map(toRunningService),
					}))
				}
				const repositories = {
					repositories: connected
						.map(({ repository }) => {
							const scan = latest.get(repository.id)
							return {
								id: repository.id,
								fullName: repository.fullName,
								htmlUrl: repository.htmlUrl,
								trackedBranch: repository.trackedBranch ?? repository.defaultBranch,
								latestScan: scan === undefined ? null : scanSummaryOf(scan),
								runningCommits: runningCommitsOf(repository.id),
							}
						})
						.sort((a, b) => a.fullName.localeCompare(b.fullName)),
				}
				return { repositories, productionScans: productionScanJobs(connected, production, now) }
			})

			const listFindings: DependencyScanServiceApi["listFindings"] = Effect.fn(
				"DependencyScanReader.listFindings",
			)(function* (tenant, query) {
				const orgId = tenant.orgId
				// Only repositories the org still has: a purged or removed one's findings are not shown.
				const connected = yield* connectedRepositories(orgId)
				const names = new Map(connected.map(({ repository }) => [repository.id, repository.fullName]))
				const rows = yield* store
					.listFindings({
						orgId,
						limit: FINDINGS_CANDIDATES,
						status: query.status,
						repositoryId: query.repositoryId,
						repositoryIds: [...names.keys()],
					})
					.pipe(Effect.mapError(persistence("Could not list findings")))
				const production = yield* productionOrNone(tenant, connected)
				const byFinding = productionByFinding(
					production.running,
					production.completed,
					production.matches,
				)
				const ranked = rows
					.map((row, order) => {
						const services = byFinding.get(findingKey(row)) ?? []
						const spans = services.reduce((sum, service) => sum + service.spanCount, 0)
						return { row, order, services, score: riskScore(row, spans) }
					})
					.sort((a, b) => b.score - a.score || a.order - b.order)
					.slice(0, FINDINGS_LIMIT)
				yield* Effect.annotateCurrentSpan({
					"result.rowCount": ranked.length,
					"maple.depscan.findings_in_production": ranked.filter(
						(entry) => entry.services.length > 0,
					).length,
				})
				return {
					findings: ranked.map(({ row, services }) =>
						findingViewOf(row, names.get(row.repositoryId) ?? "", services.map(toRunningService)),
					),
					production: {
						available: production.available,
						complete: production.complete,
						runningServices: production.runningServices,
						linkedServices: distinctServices(production.running),
					},
				}
			})

			const getFinding: DependencyScanReaderApi["getFinding"] = Effect.fn(
				"DependencyScanReader.getFinding",
			)(function* (tenant, id) {
				const row = yield* store
					.getFinding({ orgId: tenant.orgId, id })
					.pipe(Effect.mapError(persistence("Could not read the finding")))
				if (Option.isNone(row)) return Option.none()
				const connected = yield* connectedRepositories(tenant.orgId)
				const owner = connected.find((entry) => entry.repository.id === row.value.repositoryId)
				if (owner === undefined) return Option.none()
				const production = yield* productionOrNone(tenant, connected)
				const services =
					productionByFinding(production.running, production.completed, production.matches).get(
						findingKey(row.value),
					) ?? []
				return Option.some({
					finding: findingViewOf(
						row.value,
						owner.repository.fullName,
						services.map(toRunningService),
					),
					productionKnown: production.available,
				})
			})

			return {
				connectedRepositories,
				listRepositories,
				listFindings,
				getFinding,
			} satisfies DependencyScanReaderApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(DependencyScanStore.layer, VcsRepository.layer, RunningCommits.layer)),
	)
}

export class DependencyScanService extends Context.Service<DependencyScanService, DependencyScanServiceApi>()(
	"@maple/backend/services/dependency-scan/DependencyScanService",
	{
		make: Effect.gen(function* () {
			const store = yield* DependencyScanStore
			const vcs = yield* VcsRepository
			const queue = yield* VcsSyncQueue
			const reader = yield* DependencyScanReader.make
			const { connectedRepositories, listFindings } = reader

			/** Queues the scans running commits need. A queue failure is logged: the read it runs beside still answers. */
			const queueProductionScans = Effect.fn("DependencyScanService.queueProductionScans")(function* (
				jobs: ReadonlyArray<VcsSyncJob>,
			) {
				yield* Effect.annotateCurrentSpan({ "maple.depscan.production_queued": jobs.length })
				if (jobs.length === 0) return
				yield* queue
					.sendBatch(jobs)
					.pipe(
						Effect.catch((error) =>
							Effect.logWarning("[DependencyScan] could not queue production scans").pipe(
								Effect.annotateLogs({ error: error.message }),
							),
						),
					)
			})

			const listRepositories: DependencyScanServiceApi["listRepositories"] = Effect.fn(
				"DependencyScanService.listRepositories",
			)(function* (tenant) {
				const { repositories, productionScans } = yield* reader.listRepositories(tenant)
				// The tab reads repositories and findings together; only this read queues, so each commit is queued once.
				yield* queueProductionScans(productionScans)
				return repositories
			})

			const requestScan: DependencyScanServiceApi["requestScan"] = Effect.fn(
				"DependencyScanService.requestScan",
			)(function* (orgId, repositoryId) {
				const notFound = new DependencyScanRepositoryNotFoundError({
					message: "This repository is not connected to the organization",
					repositoryId,
				})
				const repository = yield* vcs
					.getRepositoryById(orgId, repositoryId)
					.pipe(Effect.mapError(persistence("Could not read the repository")))
				if (Option.isNone(repository) || repository.value.status !== "active") return yield* notFound
				const installation = yield* vcs
					.getInstallationById(orgId, repository.value.installationId)
					.pipe(Effect.mapError(persistence("Could not read the installation")))
				if (Option.isNone(installation) || !isInstallationProcessable(installation.value))
					return yield* notFound
				yield* queue
					.send({
						kind: "dependency-scan",
						provider: repository.value.provider,
						externalInstallationId: installation.value.externalInstallationId,
						externalRepoId: repository.value.externalRepoId,
						trigger: "manual",
					})
					.pipe(Effect.mapError(persistence("Could not queue the scan")))
				return { queued: true }
			})

			const updateFinding: DependencyScanServiceApi["updateFinding"] = Effect.fn(
				"DependencyScanService.updateFinding",
			)(function* (orgId, actor, findingId, request) {
				// A finding of a repository the org no longer has is not listed, so it cannot be triaged either.
				const notFound = new DependencyFindingNotFoundError({ message: "No such finding", findingId })
				const existing = yield* store
					.getFinding({ orgId, id: findingId })
					.pipe(Effect.mapError(persistence("Could not read the finding")))
				if (Option.isNone(existing)) return yield* notFound
				const connected = yield* connectedRepositories(orgId)
				if (!connected.some((entry) => entry.repository.id === existing.value.repositoryId))
					return yield* notFound
				const row = yield* store
					.setFindingStatus({
						orgId,
						id: findingId,
						status: request.status,
						reason: request.reason ?? null,
						actor,
					})
					.pipe(
						Effect.catchTags({
							"@maple/dependency-scan/DependencyFindingNotFoundError": () =>
								Effect.fail(
									new DependencyFindingNotFoundError({
										message: "No such finding",
										findingId,
									}),
								),
							"@maple/dependency-scan/DependencyScanPersistenceError": (error) =>
								Effect.fail(persistence("Could not update the finding")(error)),
						}),
					)
				const repository = yield* vcs
					.getRepositoryById(orgId, row.repositoryId)
					.pipe(Effect.mapError(persistence("Could not read the repository")))
				// Production is the list read's to add; the page re-reads findings after a triage.
				return findingViewOf(
					row,
					Option.match(repository, {
						onNone: () => "unknown repository",
						onSome: (r) => r.fullName,
					}),
					[],
				)
			})

			return {
				listRepositories,
				requestScan,
				listFindings,
				updateFinding,
			} satisfies DependencyScanServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				DependencyScanStore.layer,
				VcsRepository.layer,
				VcsSyncQueue.layer,
				RunningCommits.layer,
			),
		),
	)
}
