import type { AdvisorySeverity } from "@maple/domain/package-advisories"
import type { DependencyRelation } from "@maple/domain/dependency-scan"
import {
	DEPENDENCY_FINDING_REASON_MAX_LENGTH,
	type DependencyFindingView,
	type DependencyProductionCoverage,
	type DependencyScanRepository,
	type VcsRepositoryId,
} from "@maple/domain/http"
import { compareVersions } from "@maple/lockfiles/versions"
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

/** The repository the URL focuses, once it is one of the connected ones. */
export const focusedRepositoryOf = (model: Model): DependencyScanRepository | null =>
	repositoriesOf(model).find((repository) => repository.id === model.repositorySelect.value) ?? null

export const repositoryFilterOf = (model: Model): VcsRepositoryId | null =>
	focusedRepositoryOf(model)?.id ?? null

export const openFindingsOf = (
	findings: ReadonlyArray<DependencyFindingView>,
	repositoryId: VcsRepositoryId,
): ReadonlyArray<DependencyFindingView> =>
	findings.filter((finding) => finding.status === "open" && finding.repositoryId === repositoryId)

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

const SEVERITY_RANK = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
	unknown: 4,
} satisfies Record<AdvisorySeverity, number>

/** How directly the code leans on a package: a direct one is the bump a person makes. */
const RELATION_RANK = {
	direct: 0,
	dev: 1,
	transitive: 2,
	unknown: 3,
} satisfies Record<DependencyRelation, number>

/** One package bump in a repository: the version that clears every open advisory it can. */
export type UpgradeStep = Readonly<{
	key: string
	ecosystem: DependencyFindingView["ecosystem"]
	packageName: string
	installed: ReadonlyArray<string>
	/** The highest fixed version across its advisories; null when none has a fix yet. */
	target: string | null
	/** Open advisories the bump clears, once each however many lockfiles carry them. */
	fixes: ReadonlyArray<DependencyFindingView>
	/** Open advisories on the package with no fixed version yet, once each. */
	unfixed: ReadonlyArray<DependencyFindingView>
	severity: AdvisorySeverity
	relation: DependencyRelation
	lockfiles: ReadonlyArray<string>
	/** Spans its running services served over the last day; 0 when none runs it. */
	productionSpans: number
	services: ReadonlyArray<string>
}>

const worst = <A extends string>(values: ReadonlyArray<A>, rank: Record<A, number>, fallback: A): A =>
	values.reduce((best, value) => (rank[value] < rank[best] ? value : best), fallback)

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)]

/** A finding is per lockfile; the plan counts each advisory once. */
const byAdvisory = (findings: ReadonlyArray<DependencyFindingView>): ReadonlyArray<DependencyFindingView> => [
	...new Map(findings.map((finding) => [finding.advisoryId, finding] as const)).values(),
]

const stepOf = (key: string, findings: ReadonlyArray<DependencyFindingView>): UpgradeStep => {
	const [first] = findings
	const ecosystem = first?.ecosystem ?? "npm"
	const fixes = byAdvisory(findings.filter((finding) => finding.fixedIn !== null))
	const target = fixes.reduce<string | null>(
		(highest, finding) =>
			finding.fixedIn !== null &&
			(highest === null || compareVersions(ecosystem, finding.fixedIn, highest) > 0)
				? finding.fixedIn
				: highest,
		null,
	)
	// The same service appears once per finding; count each one's traffic once.
	const spans = new Map(
		findings.flatMap((finding) =>
			finding.production.map(
				(service) =>
					[`${service.serviceName}/${service.environment}@${service.commitSha}`, service] as const,
			),
		),
	)
	const services = [...spans.values()].sort((a, b) => b.spanCount - a.spanCount)
	return {
		key,
		ecosystem,
		packageName: first?.packageName ?? "",
		installed: unique(findings.flatMap((finding) => finding.versions)).toSorted((a, b) =>
			compareVersions(ecosystem, a, b),
		),
		target,
		fixes,
		unfixed: byAdvisory(findings.filter((finding) => finding.fixedIn === null)).filter(
			(finding) => !fixes.some((fixed) => fixed.advisoryId === finding.advisoryId),
		),
		severity: worst(
			findings.map((finding) => finding.severity),
			SEVERITY_RANK,
			"unknown",
		),
		relation: worst(
			findings.map((finding) => finding.relation),
			RELATION_RANK,
			"unknown",
		),
		lockfiles: unique(findings.map((finding) => finding.lockfilePath)),
		productionSpans: services.reduce((sum, service) => sum + service.spanCount, 0),
		services: unique(services.map((service) => service.serviceName)),
	}
}

/**
 * A repository's open findings as package bumps, the one to make first on top: worst severity,
 * then direct before transitive, then what production runs, then the most advisories cleared. Packages with no fix go last.
 */
export const upgradePlanOf = (findings: ReadonlyArray<DependencyFindingView>): ReadonlyArray<UpgradeStep> => {
	const groups = new Map<string, ReadonlyArray<DependencyFindingView>>()
	findings
		.filter((finding) => finding.status === "open")
		.forEach((finding) => {
			const key = `${finding.repositoryId}/${finding.ecosystem}/${finding.packageName}`
			groups.set(key, [...(groups.get(key) ?? []), finding])
		})
	return [...groups.entries()]
		.map(([key, group]) => stepOf(key, group))
		.toSorted(
			(a, b) =>
				Number(a.target === null) - Number(b.target === null) ||
				SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
				RELATION_RANK[a.relation] - RELATION_RANK[b.relation] ||
				b.productionSpans - a.productionSpans ||
				b.fixes.length - a.fixes.length,
		)
}

/** A repository's plan in a line's worth of numbers. */
export type PlanSummary = Readonly<{ upgrades: number; fixable: number; unfixed: number; open: number }>

export const planSummaryOf = (plan: ReadonlyArray<UpgradeStep>): PlanSummary =>
	plan.reduce<PlanSummary>(
		(sum, step) => ({
			upgrades: sum.upgrades + (step.target === null ? 0 : 1),
			fixable: sum.fixable + step.fixes.length,
			unfixed: sum.unfixed + step.unfixed.length,
			open: sum.open + step.fixes.length + step.unfixed.length,
		}),
		{ upgrades: 0, fixable: 0, unfixed: 0, open: 0 },
	)

/** Services that ran one of the repository's commits over the last day. */
export const runningServicesOf = (repository: DependencyScanRepository): ReadonlyArray<string> =>
	unique(
		repository.runningCommits.flatMap((commit) => commit.services.map((service) => service.serviceName)),
	)
