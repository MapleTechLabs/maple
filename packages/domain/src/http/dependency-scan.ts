import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import {
	DependencyFinding,
	DependencyFindingId,
	DependencyFindingStatus,
	DependencyFindingTriageStatus,
	DependencyScanId,
	DependencyScanLockfile,
	DependencyScanStatus,
	DependencyScanTrigger,
} from "../dependency-scan"
import { SessionAuthorization } from "./current-tenant"
import { GitCommitSha, VcsRepositoryId } from "./vcs"

// The Security Center's Dependencies tab: known vulnerable packages in connected repositories'
// lockfiles. Dashboard only, served by the api Worker.

export const DEPENDENCY_FINDING_REASON_MAX_LENGTH = 500

/** One scan as the tab shows it; timestamps are epoch ms. */
export const DependencyScanSummary = Schema.Struct({
	id: DependencyScanId,
	commitSha: GitCommitSha,
	ref: Schema.NullOr(Schema.String),
	trigger: DependencyScanTrigger,
	status: DependencyScanStatus,
	lockfiles: Schema.Array(DependencyScanLockfile),
	packageCount: Schema.Int,
	vulnerableCount: Schema.Int,
	error: Schema.NullOr(Schema.String),
	startedAt: Schema.Finite,
	finishedAt: Schema.NullOr(Schema.Finite),
})
export type DependencyScanSummary = typeof DependencyScanSummary.Type

/** A service serving traffic from one commit over the last day; spans are what it served. */
export const DependencyRunningService = Schema.Struct({
	serviceName: Schema.String,
	environment: Schema.String,
	commitSha: GitCommitSha,
	spanCount: Schema.Finite,
})
export type DependencyRunningService = typeof DependencyRunningService.Type

/** A commit of the repository that services run, and the scan that read it (null until one does). */
export const DependencyRunningCommit = Schema.Struct({
	commitSha: GitCommitSha,
	scanStatus: Schema.NullOr(DependencyScanStatus),
	services: Schema.Array(DependencyRunningService),
})
export type DependencyRunningCommit = typeof DependencyRunningCommit.Type

/** A connected repository and its latest scan of the tracked branch, null before the first. */
export const DependencyScanRepository = Schema.Struct({
	id: VcsRepositoryId,
	fullName: Schema.String,
	htmlUrl: Schema.String,
	trackedBranch: Schema.String,
	latestScan: Schema.NullOr(DependencyScanSummary),
	/** Commits services ran over the last day, busiest first. */
	runningCommits: Schema.Array(DependencyRunningCommit),
})
export type DependencyScanRepository = typeof DependencyScanRepository.Type

export const DependencyScanRepositoriesResponse = Schema.Struct({
	repositories: Schema.Array(DependencyScanRepository),
})
export type DependencyScanRepositoriesResponse = typeof DependencyScanRepositoriesResponse.Type

/** A finding with the repository named, so the table needs no second read. */
export const DependencyFindingView = Schema.Struct({
	...DependencyFinding.fields,
	repositoryFullName: Schema.String,
	/** Services whose running commit carries the finding, busiest first; empty when none does. */
	production: Schema.Array(DependencyRunningService),
})
export type DependencyFindingView = typeof DependencyFindingView.Type

/** How much of production the findings could be joined to. */
export const DependencyProductionCoverage = Schema.Struct({
	/** False when telemetry could not be read; the findings are then ranked without it. */
	available: Schema.Boolean,
	/** Services reporting a commit (`vcs.ref.head.revision`) over the last day. */
	runningServices: Schema.Int,
	/** Of those, the ones whose commit belongs to a connected repository. */
	linkedServices: Schema.Int,
})
export type DependencyProductionCoverage = typeof DependencyProductionCoverage.Type

/** Findings most urgent first: severity, how the code depends on the package, production traffic. */
export const DependencyFindingsResponse = Schema.Struct({
	findings: Schema.Array(DependencyFindingView),
	production: DependencyProductionCoverage,
})
export type DependencyFindingsResponse = typeof DependencyFindingsResponse.Type

export const DependencyFindingsQuery = Schema.Struct({
	status: Schema.optional(DependencyFindingStatus),
	repositoryId: Schema.optional(VcsRepositoryId),
})

export const DependencyFindingUpdateRequest = Schema.Struct({
	status: DependencyFindingTriageStatus,
	reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DEPENDENCY_FINDING_REASON_MAX_LENGTH))),
})
export type DependencyFindingUpdateRequest = typeof DependencyFindingUpdateRequest.Type

export const DependencyScanQueued = Schema.Struct({ queued: Schema.Boolean })

export class DependencyScanPersistenceError extends Schema.TaggedError<DependencyScanPersistenceError>()(
	"@maple/http/dependency-scan/DependencyScanPersistenceError",
	/** `cause` names the failure behind it (its tag), never its details. */
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{ httpApiStatus: 503 },
) {}

export class DependencyScanForbiddenError extends Schema.TaggedError<DependencyScanForbiddenError>()(
	"@maple/http/dependency-scan/DependencyScanForbiddenError",
	{ message: Schema.String },
	{ httpApiStatus: 403 },
) {}

export class DependencyFindingNotFoundError extends Schema.TaggedError<DependencyFindingNotFoundError>()(
	"@maple/http/dependency-scan/DependencyFindingNotFoundError",
	{ message: Schema.String, findingId: DependencyFindingId },
	{ httpApiStatus: 404 },
) {}

export class DependencyScanRepositoryNotFoundError extends Schema.TaggedError<DependencyScanRepositoryNotFoundError>()(
	"@maple/http/dependency-scan/DependencyScanRepositoryNotFoundError",
	{ message: Schema.String, repositoryId: VcsRepositoryId },
	{ httpApiStatus: 404 },
) {}

export class DependencyScanApiGroup extends HttpApiGroup.make("dependencyScan")
	.add(
		HttpApiEndpoint.get("listRepositories", "/repositories", {
			success: DependencyScanRepositoriesResponse,
			error: DependencyScanPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("scanRepository", "/repositories/:repositoryId/scan", {
			params: { repositoryId: VcsRepositoryId },
			success: DependencyScanQueued,
			error: [DependencyScanPersistenceError, DependencyScanRepositoryNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listFindings", "/findings", {
			query: DependencyFindingsQuery,
			success: DependencyFindingsResponse,
			error: DependencyScanPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.patch("updateFinding", "/findings/:findingId", {
			params: { findingId: DependencyFindingId },
			payload: DependencyFindingUpdateRequest,
			success: DependencyFindingView,
			error: [
				DependencyScanPersistenceError,
				DependencyScanForbiddenError,
				DependencyFindingNotFoundError,
			],
		}),
	)
	.prefix("/internal/dependency-scan")
	.middleware(SessionAuthorization) {}
