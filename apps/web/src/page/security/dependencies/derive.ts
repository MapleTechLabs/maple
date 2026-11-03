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
import { Duration, Option, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { AppRoute, hrefOf } from "../../../route"
import type { SecurityDependenciesSearch } from "../../../route/search"
import {
	type Model,
	type Pane,
	type PendingScan,
	type StatusFilter,
	StatusFilter as StatusFilterSchema,
} from "./model"

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

/** The tab's URL for a scope (null is every repository) and a pane. */
export const dependenciesHref = (repositoryId: string | null, pane: Pane = "summary"): string => {
	const scope: SecurityDependenciesSearch = repositoryId === null ? {} : { repo: repositoryId }
	return hrefOf(
		AppRoute.SecurityDependencies({
			search: pane === "summary" ? scope : { ...scope, view: pane },
		}),
	)
}

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
	Arr.filter(
		findings,
		(finding) =>
			matchesStatus(finding, status) &&
			(repositoryId === null || finding.repositoryId === repositoryId),
	)

export const statusFilterOf = (model: Model): StatusFilter =>
	STATUS_FILTERS.find((status) => status === model.statusSelect.value) ?? "open"

/** The repository the URL focuses, once it is one of the connected ones. */
export const focusedRepositoryOf = (model: Model): DependencyScanRepository | null =>
	repositoriesOf(model).find((repository) => repository.id === model.scope) ?? null

/** The switcher's item for every repository; the others are each repository's full name. */
export const ALL_REPOSITORIES = "All repositories"

/** What the switcher reads while closed: the focused repository, or every one. */
export const scopeLabelOf = (model: Model): string => focusedRepositoryOf(model)?.fullName ?? ALL_REPOSITORIES

export const repositoryFilterOf = (model: Model): VcsRepositoryId | null =>
	focusedRepositoryOf(model)?.id ?? null

export const openFindingsOf = (
	findings: ReadonlyArray<DependencyFindingView>,
	repositoryId: VcsRepositoryId,
): ReadonlyArray<DependencyFindingView> =>
	Arr.filter(findings, (finding) => finding.status === "open" && finding.repositoryId === repositoryId)

export type SeverityCounts = Readonly<Record<AdvisorySeverity, number>>

const NO_SEVERITIES = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } satisfies SeverityCounts

export const openSeverityCounts = (findings: ReadonlyArray<DependencyFindingView>): SeverityCounts =>
	Arr.filter(findings, (finding) => finding.status === "open").reduce<SeverityCounts>(
		(counts, finding) => ({ ...counts, [finding.severity]: counts[finding.severity] + 1 }),
		NO_SEVERITIES,
	)

export const scannedCount = (repositories: ReadonlyArray<DependencyScanRepository>): number =>
	Arr.filter(repositories, (repository) => repository.latestScan !== null).length

export const isScanPending = (model: Model, repositoryId: VcsRepositoryId): boolean =>
	model.requestingScans.includes(repositoryId) ||
	Arr.some(model.pendingScans, (pending) => pending.repositoryId === repositoryId)

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
	const pending = Arr.filter(pendingScans, (scan) => !isSettled(scan, repositories))
	return { pending, hasSettled: pending.length < pendingScans.length }
}

export const unexpiredScans = (
	pendingScans: ReadonlyArray<PendingScan>,
	nowMs: number,
): ReadonlyArray<PendingScan> =>
	Arr.filter(pendingScans, (scan) => nowMs - scan.requestedAtMs < Duration.toMillis(SCAN_POLL_LIMIT))

export const selectedFindingOf = (model: Model): DependencyFindingView | null =>
	model.selectedId === null
		? null
		: (allFindingsOf(model).find((finding) => finding.id === model.selectedId) ?? null)

export const reasonErrorOf = (reason: string): string | null =>
	Str.trim(reason) === ""
		? "Add a reason. It is shown on the finding with your name."
		: // The API checks the reason as sent, so the cap applies to it untrimmed.
			reason.length > DEPENDENCY_FINDING_REASON_MAX_LENGTH
			? `Keep the reason under ${DEPENDENCY_FINDING_REASON_MAX_LENGTH} characters.`
			: null

/** A commit as its first seven characters, as GitHub abbreviates it. */
export const shortSha = (sha: string): string => Str.slice(0, 7)(sha)

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
	repositoryId: VcsRepositoryId
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
	Arr.reduce(values, fallback, (best, value) => (rank[value] < rank[best] ? value : best))

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)]

/** A finding is per lockfile; the plan counts each advisory once. */
const byAdvisory = (findings: ReadonlyArray<DependencyFindingView>): ReadonlyArray<DependencyFindingView> => [
	...new Map(Arr.map(findings, (finding) => [finding.advisoryId, finding] as const)).values(),
]

const stepOf = (
	key: string,
	repositoryId: VcsRepositoryId,
	findings: ReadonlyArray<DependencyFindingView>,
): UpgradeStep => {
	const [first] = findings
	const ecosystem = first?.ecosystem ?? "npm"
	const fixable = Arr.filter(findings, (finding) => finding.fixedIn !== null)
	const fixes = byAdvisory(fixable)
	// Every lockfile's fix counts: one advisory can need a higher version in another lockfile.
	const target = fixable.reduce<string | null>(
		(highest, finding) =>
			finding.fixedIn !== null &&
			(highest === null || compareVersions(ecosystem, finding.fixedIn, highest) > 0)
				? finding.fixedIn
				: highest,
		null,
	)
	// The same service appears once per finding; count each one's traffic once.
	const spans = new Map(
		Arr.flatMap(findings, (finding) =>
			Arr.map(
				finding.production,
				(service) =>
					[`${service.serviceName}/${service.environment}@${service.commitSha}`, service] as const,
			),
		),
	)
	const services = [...spans.values()].sort((a, b) => b.spanCount - a.spanCount)
	return {
		key,
		repositoryId,
		ecosystem,
		packageName: first?.packageName ?? "",
		installed: unique(Arr.flatMap(findings, (finding) => finding.versions)).toSorted((a, b) =>
			compareVersions(ecosystem, a, b),
		),
		target,
		fixes,
		unfixed: Arr.filter(
			byAdvisory(Arr.filter(findings, (finding) => finding.fixedIn === null)),
			(finding) => !Arr.some(fixes, (fixed) => fixed.advisoryId === finding.advisoryId),
		),
		severity: worst(
			Arr.map(findings, (finding) => finding.severity),
			SEVERITY_RANK,
			"unknown",
		),
		relation: worst(
			Arr.map(findings, (finding) => finding.relation),
			RELATION_RANK,
			"unknown",
		),
		lockfiles: unique(Arr.map(findings, (finding) => finding.lockfilePath)),
		productionSpans: Arr.reduce(services, 0, (sum, service) => sum + service.spanCount),
		services: unique(Arr.map(services, (service) => service.serviceName)),
	}
}

/**
 * A repository's open findings as package bumps, the one to make first on top: worst severity,
 * then direct before transitive, then what production runs, then the most advisories cleared. Packages with no fix go last.
 */
export const upgradePlanOf = (findings: ReadonlyArray<DependencyFindingView>): ReadonlyArray<UpgradeStep> => {
	const groups = new Map<string, ReadonlyArray<DependencyFindingView>>()
	const repositoryOf = new Map<string, VcsRepositoryId>()
	Arr.forEach(
		Arr.filter(findings, (finding) => finding.status === "open"),
		(finding) => {
			const key = `${finding.repositoryId}/${finding.ecosystem}/${finding.packageName}`
			groups.set(key, [...(groups.get(key) ?? []), finding])
			repositoryOf.set(key, finding.repositoryId)
		},
	)
	return Arr.flatMap([...groups.entries()], ([key, group]) => {
		const repositoryId = repositoryOf.get(key)
		return repositoryId === undefined ? [] : [stepOf(key, repositoryId, group)]
	}).toSorted(
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
		Arr.flatMap(repository.runningCommits, (commit) =>
			Arr.map(commit.services, (service) => service.serviceName),
		),
	)

/** Open advisories, each once per repository and package however many lockfiles carry it. */
export const openAdvisoryCount = (findings: ReadonlyArray<DependencyFindingView>): number =>
	planSummaryOf(upgradePlanOf(findings)).open

/** The worst open severity among the findings; null when nothing is open. */
export const worstOpenSeverity = (
	findings: ReadonlyArray<DependencyFindingView>,
): AdvisorySeverity | null => {
	const open = Arr.filter(findings, (finding) => finding.status === "open")
	return open.length === 0
		? null
		: worst(
				Arr.map(open, (finding) => finding.severity),
				SEVERITY_RANK,
				"unknown",
			)
}

/** One vulnerable package across the repositories: its plan step in each one that has it open. */
export type PackageRow = Readonly<{
	key: string
	ecosystem: DependencyFindingView["ecosystem"]
	packageName: string
	steps: ReadonlyMap<VcsRepositoryId, UpgradeStep>
	severity: AdvisorySeverity
	/** The highest version any repository needs; null when no repository has a fix to bump to. */
	target: string | null
	productionSpans: number
}>

const rowOf = (key: string, steps: ReadonlyArray<UpgradeStep>): PackageRow => {
	const ecosystem = steps[0]?.ecosystem ?? "npm"
	return {
		key,
		ecosystem,
		packageName: steps[0]?.packageName ?? "",
		steps: new Map(Arr.map(steps, (step) => [step.repositoryId, step] as const)),
		severity: worst(
			Arr.map(steps, (step) => step.severity),
			SEVERITY_RANK,
			"unknown",
		),
		target: steps.reduce<string | null>(
			(highest, step) =>
				step.target !== null &&
				(highest === null || compareVersions(ecosystem, step.target, highest) > 0)
					? step.target
					: highest,
			null,
		),
		productionSpans: Arr.reduce(steps, 0, (sum, step) => sum + step.productionSpans),
	}
}

/**
 * The matrix's rows: every open vulnerable package, worst first, then what production runs, then
 * the one in the most repositories.
 */
export const packageMatrixOf = (
	findings: ReadonlyArray<DependencyFindingView>,
): ReadonlyArray<PackageRow> => {
	const groups = new Map<string, ReadonlyArray<UpgradeStep>>()
	Arr.forEach(upgradePlanOf(findings), (step) => {
		const key = `${step.ecosystem}/${step.packageName}`
		groups.set(key, [...(groups.get(key) ?? []), step])
	})
	return Arr.map([...groups.entries()], ([key, steps]) => rowOf(key, steps)).toSorted(
		(a, b) =>
			SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
			b.productionSpans - a.productionSpans ||
			b.steps.size - a.steps.size ||
			Str.localeCompare(b.packageName)(a.packageName),
	)
}

/** One repository's findings, its worst open severity and how many advisories are open. */
export type RepositoryStats = Readonly<{
	findings: ReadonlyArray<DependencyFindingView>
	worst: AdvisorySeverity | null
	open: number
}>

/** What the tab reads off one pair of answers, built once: a render reuses it. */
export type Digest = Readonly<{
	repositories: ReadonlyArray<DependencyScanRepository>
	findings: ReadonlyArray<DependencyFindingView>
	statsOf: (repositoryId: VcsRepositoryId) => RepositoryStats
	/** Riskiest first: the worst open severity, then the most open advisories; nothing open goes last. */
	ranked: ReadonlyArray<DependencyScanRepository>
	/** The matrix's rows. */
	packages: ReadonlyArray<PackageRow>
	/** The repositories with anything open, riskiest first. */
	affected: ReadonlyArray<DependencyScanRepository>
	/** Every repository's open advisories. */
	open: number
	worst: AdvisorySeverity | null
}>

const NO_STATS: RepositoryStats = { findings: [], worst: null, open: 0 }

const buildDigest = (
	repositories: ReadonlyArray<DependencyScanRepository>,
	findings: ReadonlyArray<DependencyFindingView>,
): Digest => {
	const grouped = new Map<string, Array<DependencyFindingView>>()
	Arr.forEach(findings, (finding) => {
		const group = grouped.get(finding.repositoryId)
		if (group === undefined) grouped.set(finding.repositoryId, [finding])
		else group.push(finding)
	})
	const stats = new Map(
		Arr.map(
			[...grouped.entries()],
			([repositoryId, own]) =>
				[
					repositoryId,
					{ findings: own, worst: worstOpenSeverity(own), open: openAdvisoryCount(own) },
				] as const,
		),
	)
	const statsOf = (repositoryId: VcsRepositoryId): RepositoryStats => stats.get(repositoryId) ?? NO_STATS
	const rankOf = (repository: DependencyScanRepository) => {
		const { worst: severity } = statsOf(repository.id)
		return severity === null ? 5 : SEVERITY_RANK[severity]
	}
	const ranked = repositories.toSorted(
		(a, b) =>
			rankOf(a) - rankOf(b) ||
			statsOf(b.id).open - statsOf(a.id).open ||
			Str.localeCompare(b.fullName)(a.fullName),
	)
	return {
		repositories,
		findings,
		statsOf,
		ranked,
		packages: packageMatrixOf(findings),
		affected: Arr.filter(ranked, (repository) => statsOf(repository.id).open > 0),
		open: Arr.reduce([...stats.values()], 0, (sum, entry) => sum + entry.open),
		worst: worstOpenSeverity(findings),
	}
}

// The answers are immutable, so their identities key the digest: a keystroke or a click reuses it.
const digests = new WeakMap<object, WeakMap<object, Digest>>()

export const digestOf = (
	repositories: ReadonlyArray<DependencyScanRepository>,
	findings: ReadonlyArray<DependencyFindingView>,
): Digest => {
	const byFindings = digests.get(repositories) ?? new WeakMap<object, Digest>()
	const hit = byFindings.get(findings)
	if (hit !== undefined) return hit
	const digest = buildDigest(repositories, findings)
	byFindings.set(findings, digest)
	digests.set(repositories, byFindings)
	return digest
}

/** The matrix's column budget: past it, the riskiest repositories keep a column and the rest a count. */
export const MATRIX_COLUMNS = 5

/** An opened package lists this many repositories before "Show all". */
export const EXPANSION_ROWS = 24

/** The repositories and advisories tables render this many rows at a time. */
export const PAGE_ROWS = 100
