import type { AdvisorySeverity } from "@maple/domain/package-advisories"
import type { DependencyRelation } from "@maple/domain/dependency-scan"
import {
	DEPENDENCY_FINDING_REASON_MAX_LENGTH,
	type DependencyFindingView,
	type DependencyProductionCoverage,
	type DependencyScanRepository,
	type VcsRepositoryId,
} from "@maple/domain/http"
import { Duration, Option } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "../../../data/load-failure"
import { type Model, type PendingScan, type StatusFilter, StatusFilter as StatusFilterSchema } from "./model"

// What the Dependencies tab shows, read off its two slots.

export const STATUS_FILTERS: ReadonlyArray<StatusFilter> = StatusFilterSchema.literals

export const STATUS_FILTER_LABEL = {
	open: "Open",
	dismissed: "Dismissed",
	accepted_risk: "Accepted risk",
	fixed: "Fixed",
	all: "All",
} satisfies Record<StatusFilter, string>

export const SEVERITY_LABEL = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	unknown: "Unrated",
} satisfies Record<AdvisorySeverity, string>

export const RELATION_LABEL = {
	direct: "Direct",
	dev: "Dev",
	transitive: "Transitive",
	unknown: "Unknown",
} satisfies Record<DependencyRelation, string>

/** A pending scan stops polling after this long, whether or not a newer scan showed up. */
export const SCAN_POLL_LIMIT = Duration.minutes(2)

export const repositoriesOf = (model: Model): ReadonlyArray<DependencyScanRepository> =>
	Option.getOrNull(AsyncData.getData(model.repositories.data))?.repositories ?? []

export const allFindingsOf = (model: Model): ReadonlyArray<DependencyFindingView> =>
	Option.getOrNull(AsyncData.getData(model.findings.data))?.findings ?? []

export type PageState =
	| Readonly<{ _tag: "Loading" }>
	| Readonly<{ _tag: "Failed"; failure: LoadFailure }>
	| Readonly<{ _tag: "NotConnected" }>
	| Readonly<{
			_tag: "Ready"
			repositories: ReadonlyArray<DependencyScanRepository>
			findings: ReadonlyArray<DependencyFindingView>
			production: DependencyProductionCoverage
	  }>

/** A failed read with nothing to show; a stale one keeps its data on screen. */
const failureOf = <A>(data: AsyncData.AsyncData<A, LoadFailure>): LoadFailure | null =>
	AsyncData.isFailure(data) ? Option.getOrNull(AsyncData.getError(data)) : null

/** Either read failing fails the tab; it shows once both are in. */
export const pageStateOf = (model: Model): PageState => {
	const failure = failureOf(model.repositories.data)
	const findingsFailure = failureOf(model.findings.data)
	if (failure !== null) return { _tag: "Failed", failure }
	if (findingsFailure !== null) return { _tag: "Failed", failure: findingsFailure }
	const repositories = Option.getOrNull(AsyncData.getData(model.repositories.data))
	const findings = Option.getOrNull(AsyncData.getData(model.findings.data))
	if (repositories === null || findings === null) return { _tag: "Loading" }
	if (repositories.repositories.length === 0) return { _tag: "NotConnected" }
	return {
		_tag: "Ready",
		repositories: repositories.repositories,
		findings: findings.findings,
		production: findings.production,
	}
}

export const matchesStatus = (finding: DependencyFindingView, status: StatusFilter): boolean =>
	status === "all" || finding.status === status

/** The table's rows: the server's order (worst first) under the two filters. */
export const filteredFindings = (
	findings: ReadonlyArray<DependencyFindingView>,
	status: StatusFilter,
	repositoryId: VcsRepositoryId | null,
): ReadonlyArray<DependencyFindingView> =>
	findings.filter(
		(finding) =>
			matchesStatus(finding, status) &&
			(repositoryId === null || finding.repositoryId === repositoryId),
	)

export const statusFilterOf = (model: Model): StatusFilter =>
	STATUS_FILTERS.find((status) => status === model.statusSelect.value) ?? "open"

export const repositoryFilterOf = (model: Model): VcsRepositoryId | null =>
	repositoriesOf(model).find((repository) => repository.id === model.repositorySelect.value)?.id ?? null

export type SeverityCounts = Readonly<Record<AdvisorySeverity, number>>

const NO_SEVERITIES = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } satisfies SeverityCounts

export const openSeverityCounts = (findings: ReadonlyArray<DependencyFindingView>): SeverityCounts =>
	findings
		.filter((finding) => finding.status === "open")
		.reduce<SeverityCounts>(
			(counts, finding) => ({ ...counts, [finding.severity]: counts[finding.severity] + 1 }),
			NO_SEVERITIES,
		)

export const scannedCount = (repositories: ReadonlyArray<DependencyScanRepository>): number =>
	repositories.filter((repository) => repository.latestScan !== null).length

export const isScanPending = (model: Model, repositoryId: VcsRepositoryId): boolean =>
	model.requestingScans.includes(repositoryId) ||
	model.pendingScans.some((pending) => pending.repositoryId === repositoryId)

/** A pending scan is done once its repository shows a newer scan that has finished. */
const isSettled = (pending: PendingScan, repositories: ReadonlyArray<DependencyScanRepository>): boolean => {
	const scan = repositories.find((repository) => repository.id === pending.repositoryId)?.latestScan ?? null
	return scan !== null && scan.id !== pending.previousScanId && scan.status !== "running"
}

/** The scans still to poll for, and whether any finished (so the findings are read again). */
export const settlePendingScans = (
	pendingScans: ReadonlyArray<PendingScan>,
	repositories: ReadonlyArray<DependencyScanRepository>,
): Readonly<{ pending: ReadonlyArray<PendingScan>; hasSettled: boolean }> => {
	const pending = pendingScans.filter((scan) => !isSettled(scan, repositories))
	return { pending, hasSettled: pending.length < pendingScans.length }
}

export const unexpiredScans = (
	pendingScans: ReadonlyArray<PendingScan>,
	nowMs: number,
): ReadonlyArray<PendingScan> =>
	pendingScans.filter((scan) => nowMs - scan.requestedAtMs < Duration.toMillis(SCAN_POLL_LIMIT))

export const selectedFindingOf = (model: Model): DependencyFindingView | null =>
	model.selectedId === null
		? null
		: (allFindingsOf(model).find((finding) => finding.id === model.selectedId) ?? null)

export const reasonErrorOf = (reason: string): string | null =>
	reason.trim() === ""
		? "Add a reason. It is shown on the finding with your name."
		: // The API checks the reason as sent, so the cap applies to it untrimmed.
			reason.length > DEPENDENCY_FINDING_REASON_MAX_LENGTH
			? `Keep the reason under ${DEPENDENCY_FINDING_REASON_MAX_LENGTH} characters.`
			: null

/** A commit as its first seven characters, as GitHub abbreviates it. */
export const shortSha = (sha: string): string => sha.slice(0, 7)
