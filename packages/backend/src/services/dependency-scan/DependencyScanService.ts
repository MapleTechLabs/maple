import type { DependencyFindingRow, DependencyScanRow } from "@maple/db/tables"
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
	isInstallationProcessable,
	type VcsRepo,
	type VcsRepositoryId,
} from "@maple/domain/http"
import type { OrgId, UserId } from "@maple/domain/primitives"
import type { DependencyFindingStatus } from "@maple/domain/dependency-scan"
import { Context, Effect, Layer, Option } from "effect"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { VcsSyncQueue } from "@maple/backend/services/integrations/vcs/VcsSyncQueue"
import { DependencyScanStore } from "./DependencyScanStore"

// The Dependencies tab's reads and writes: repositories with their latest scan, findings with
// their repository named, triage, and "scan now", which goes through the VCS sync queue.

/** Findings returned per read; the table sorts worst first, so the cut drops the least severe. */
export const FINDINGS_LIMIT = 500

export interface DependencyScanServiceApi {
	readonly listRepositories: (
		orgId: OrgId,
	) => Effect.Effect<DependencyScanRepositoriesResponse, DependencyScanPersistenceError>
	readonly requestScan: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
	) => Effect.Effect<
		{ readonly queued: boolean },
		DependencyScanPersistenceError | DependencyScanRepositoryNotFoundError
	>
	readonly listFindings: (
		orgId: OrgId,
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
	(error: { readonly message: string }): DependencyScanPersistenceError =>
		new DependencyScanPersistenceError({ message: `${message}: ${error.message}` })

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
): DependencyFindingView => ({
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

export class DependencyScanService extends Context.Service<DependencyScanService, DependencyScanServiceApi>()(
	"@maple/backend/services/dependency-scan/DependencyScanService",
	{
		make: Effect.gen(function* () {
			const store = yield* DependencyScanStore
			const vcs = yield* VcsRepository
			const queue = yield* VcsSyncQueue

			/** The org's repositories under a processable installation, active ones only. */
			const connectedRepositories = Effect.fn("DependencyScanService.connectedRepositories")(function* (
				orgId: OrgId,
			) {
				const installations = (yield* vcs.listInstallationsByOrg(orgId)).filter(
					isInstallationProcessable,
				)
				const repositories = yield* Effect.forEach(installations, (installation) =>
					vcs.listRepositoriesByInstallation(installation.id, "active"),
				)
				return repositories.flat()
			})

			const listRepositories: DependencyScanServiceApi["listRepositories"] = Effect.fn(
				"DependencyScanService.listRepositories",
			)(function* (orgId) {
				const repositories = yield* connectedRepositories(orgId).pipe(
					Effect.mapError(persistence("Could not list repositories")),
				)
				const branchScans = yield* store
					.latestBranchScans({ orgId })
					.pipe(Effect.mapError(persistence("Could not list scans")))
				const latest = new Map(branchScans.map((scan) => [scan.repositoryId, scan]))
				return {
					repositories: repositories
						.map((repository: VcsRepo) => {
							const scan = latest.get(repository.id)
							return {
								id: repository.id,
								fullName: repository.fullName,
								htmlUrl: repository.htmlUrl,
								trackedBranch: repository.trackedBranch ?? repository.defaultBranch,
								latestScan: scan === undefined ? null : scanSummaryOf(scan),
							}
						})
						.sort((a, b) => a.fullName.localeCompare(b.fullName)),
				}
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

			const listFindings: DependencyScanServiceApi["listFindings"] = Effect.fn(
				"DependencyScanService.listFindings",
			)(function* (orgId, query) {
				const rows = yield* store
					.listFindings({
						orgId,
						limit: FINDINGS_LIMIT,
						status: query.status,
						repositoryId: query.repositoryId,
					})
					.pipe(Effect.mapError(persistence("Could not list findings")))
				const repositories = yield* vcs
					.getRepositoriesByIds(
						orgId,
						rows.map((row) => row.repositoryId),
					)
					.pipe(Effect.mapError(persistence("Could not read repositories")))
				// A purged or removed repository's findings stay in the table but are not shown.
				const names = new Map(
					repositories
						.filter((repository) => repository.status === "active")
						.map((repository) => [repository.id, repository.fullName]),
				)
				const findings = rows.flatMap((row) => {
					const name = names.get(row.repositoryId)
					return name === undefined ? [] : [findingViewOf(row, name)]
				})
				yield* Effect.annotateCurrentSpan({ "result.rowCount": findings.length })
				return { findings }
			})

			const updateFinding: DependencyScanServiceApi["updateFinding"] = Effect.fn(
				"DependencyScanService.updateFinding",
			)(function* (orgId, actor, findingId, request) {
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
				return findingViewOf(
					row,
					Option.match(repository, {
						onNone: () => "unknown repository",
						onSome: (r) => r.fullName,
					}),
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
		Layer.provide(Layer.mergeAll(DependencyScanStore.layer, VcsRepository.layer, VcsSyncQueue.layer)),
	)
}
