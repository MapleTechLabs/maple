import type {
	GithubRepoSummary,
	SecurityAuditFinding,
	SecurityAuditRun,
	SecurityAuditRunDetail,
	SecurityAuditTarget,
} from "@maple/domain/http"
import type { SecurityAuditFindingStatus, SecurityAuditSeverity } from "@maple/domain/security-audit"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "../../../data/load-failure"
import type { SecurityFindingsSearch } from "../../../route/search"
import { type Gate, gateOf, isLive, isSameMonth, locationOf, severityRank } from "../kit/format"
import type { FindingGroup, Model } from "./model"

// Pure readings of the tabs' Model: what each panel shows.

/** The repositories Add target offers: the connected installation's active ones. */
export const activeRepositoriesOf = (model: Model): ReadonlyArray<GithubRepoSummary> =>
	Option.match(AsyncData.getData(model.githubStatus.data), {
		onNone: () => [],
		onSome: (status) =>
			status.connected ? status.repositories.filter((repo) => repo.status === "active") : [],
	})

export const targetsOf = (model: Model): ReadonlyArray<SecurityAuditTarget> =>
	Option.match(AsyncData.getData(model.targets.data), {
		onNone: () => [],
		onSome: (response) => response.targets,
	})

/** Newest first. */
export const runsOf = (model: Model): ReadonlyArray<SecurityAuditRun> =>
	Option.match(AsyncData.getData(model.runs.data), {
		onNone: () => [],
		onSome: (response) => [...response.runs].sort((a, b) => b.startedAt - a.startedAt),
	})

export const latestRunOf = (
	runs: ReadonlyArray<SecurityAuditRun>,
	targetId: string,
): SecurityAuditRun | undefined => runs.find((run) => run.targetId === targetId)

/** Live runs in either list: polling keeps going while any is. */
export const runningRuns = (model: Model): ReadonlyArray<SecurityAuditRun> => allRuns(model).filter(isLive)

export const latestDetailOf = (model: Model, runId: string): SecurityAuditRunDetail | null =>
	Option.getOrNull(
		Option.flatMap(Option.fromNullishOr(model.latestRuns[runId]), (slot) => AsyncData.getData(slot.data)),
	)

/** The page's own gate: a disabled org shows nothing else. */
export const pageGateOf = (model: Model): Gate | null =>
	AsyncData.isFailure(model.targets.data) ? gateOf(model.targets.data.error) : null

type FindingsState =
	| Readonly<{ _tag: "Loading" }>
	| Readonly<{ _tag: "Gated"; gate: Gate }>
	| Readonly<{ _tag: "Failed"; failure: LoadFailure }>
	| Readonly<{ _tag: "Ready"; findings: ReadonlyArray<SecurityAuditFinding>; isRefreshing: boolean }>

/** Every target's findings as one list; a 403 on any of them gates the whole list. */
export const findingsStateOf = (model: Model): FindingsState => {
	// Findings are read per target: without the targets there is nothing to wait for.
	if (AsyncData.isFailure(model.targets.data)) {
		const gate = gateOf(model.targets.data.error)
		return gate === null ? { _tag: "Failed", failure: model.targets.data.error } : { _tag: "Gated", gate }
	}
	const targets = targetsOf(model)
	const slots = targets.map((target) => model.findings[target.id])
	const failures = slots.flatMap((slot) =>
		slot !== undefined && AsyncData.isFailure(slot.data) ? [slot.data.error] : [],
	)
	const gated = failures.map(gateOf).find((gate) => gate !== null)
	if (gated !== undefined && gated !== null) return { _tag: "Gated", gate: gated }
	const failure = failures[0]
	if (failure !== undefined) return { _tag: "Failed", failure }
	if (!AsyncData.hasData(model.targets.data)) return { _tag: "Loading" }
	const loaded = slots.map((slot) => (slot === undefined ? Option.none() : AsyncData.getData(slot.data)))
	if (loaded.some(Option.isNone)) return { _tag: "Loading" }
	return {
		_tag: "Ready",
		findings: loaded.flatMap((response) =>
			Option.match(response, { onNone: () => [], onSome: (r) => r.findings }),
		),
		isRefreshing: slots.some((slot) => slot !== undefined && AsyncData.isRefreshing(slot.data)),
	}
}

export const openConfirmed = (findings: ReadonlyArray<SecurityAuditFinding>) =>
	findings.filter((finding) => finding.verdict === "confirmed" && finding.status === "open")

export const openNeedsValidation = (findings: ReadonlyArray<SecurityAuditFinding>) =>
	findings.filter((finding) => finding.verdict === "needs_validation" && finding.status === "open")

export const countBySeverity = (
	findings: ReadonlyArray<SecurityAuditFinding>,
): Readonly<Record<SecurityAuditSeverity, number>> => ({
	critical: findings.filter((finding) => finding.overallSeverity === "critical").length,
	high: findings.filter((finding) => finding.overallSeverity === "high").length,
	medium: findings.filter((finding) => finding.overallSeverity === "medium").length,
	low: findings.filter((finding) => finding.overallSeverity === "low").length,
	informational: findings.filter((finding) => finding.overallSeverity === "informational").length,
})

/** Severity first, then the most recently seen. */
export const bySeverity = (a: SecurityAuditFinding, b: SecurityAuditFinding): number =>
	severityRank(a.overallSeverity) - severityRank(b.overallSeverity) || b.updatedAt - a.updatedAt

/** Closed units out of the ledger: what the run got to, whatever it found. */
const CLOSED_UNIT_STATUSES: ReadonlyArray<string> = ["covered", "candidate", "not_applicable", "out_of_scope"]

export const coverageOf = (detail: SecurityAuditRunDetail): Readonly<{ closed: number; total: number }> => ({
	closed: CLOSED_UNIT_STATUSES.reduce((sum, status) => sum + (detail.unitCounts[status] ?? 0), 0),
	total: detail.unitTotal,
})

/** The API lists at most this many runs per request, newest first. */
export const RUN_LIST_CAP = 50

const targetRunsOf = (model: Model, targetId: string): ReadonlyArray<SecurityAuditRun> | null =>
	Option.getOrNull(
		Option.flatMap(Option.fromNullishOr(model.targetRuns[targetId]), (slot) =>
			AsyncData.getData(slot.data),
		),
	)?.runs ?? null

/** Of two copies of one run, the further along: finished beats live, then more invocations spent. */
const fresher = (a: SecurityAuditRun, b: SecurityAuditRun): SecurityAuditRun =>
	a.finishedAt !== null && b.finishedAt === null
		? a
		: b.finishedAt !== null && a.finishedAt === null
			? b
			: b.invocationsSpent > a.invocationsSpent
				? b
				: a

/** Runs merged by id, the fresher copy kept, newest first. */
const mergeRuns = (lists: ReadonlyArray<ReadonlyArray<SecurityAuditRun>>): ReadonlyArray<SecurityAuditRun> =>
	[
		...lists
			.flat()
			.reduce((byId, run) => {
				const held = byId.get(run.id)
				return byId.set(run.id, held === undefined ? run : fresher(held, run))
			}, new Map<string, SecurityAuditRun>())
			.values(),
	].sort((a, b) => b.startedAt - a.startedAt)

/** A target's runs: its own list and the polled global list together, so neither goes stale. */
const runsForTarget = (model: Model, targetId: string): ReadonlyArray<SecurityAuditRun> =>
	mergeRuns([targetRunsOf(model, targetId) ?? [], runsOf(model).filter((run) => run.targetId === targetId)])

/** Every run either list holds. */
export const allRuns = (model: Model): ReadonlyArray<SecurityAuditRun> =>
	mergeRuns([runsOf(model), ...targetsOf(model).map((target) => targetRunsOf(model, target.id) ?? [])])

export const latestRunFor = (model: Model, targetId: string): SecurityAuditRun | undefined =>
	runsForTarget(model, targetId)[0]

/** The Runs tab's rows: one target's runs when narrowed to it, else every run held. */
export const runsForTab = (
	model: Model,
): Readonly<{ runs: ReadonlyArray<SecurityAuditRun>; isCapped: boolean }> => {
	const targetId = model.runsSearch.target
	const own = targetId === undefined ? null : targetRunsOf(model, targetId)
	const runs = targetId === undefined ? runsOf(model) : runsForTarget(model, targetId)
	const listed = own ?? Option.getOrNull(AsyncData.getData(model.runs.data))?.runs ?? []
	return { runs, isCapped: listed.length >= RUN_LIST_CAP }
}

export type Spend = Readonly<{
	costUsd: number
	invocations: number
	tokens: number
	/** Runs this month with no cost recorded: their spend is not in `costUsd`. */
	unpriced: number
	/** A target's list hit the cap, so older runs of this month may be missing. */
	isPartial: boolean
}>

/** This month's runs across every target's own list (the global list stops at the cap). */
export const spendThisMonth = (model: Model): Spend => {
	const lists = targetsOf(model).map((target) => targetRunsOf(model, target.id))
	const isPartial = lists.some((runs) => runs === null || runs.length >= RUN_LIST_CAP)
	return allRuns(model)
		.filter((run) => isSameMonth(run.startedAt, model.nowMs))
		.reduce<Spend>(
			(sum, run) => ({
				costUsd: sum.costUsd + (run.costUsd ?? 0),
				invocations: sum.invocations + run.invocationsSpent,
				tokens: sum.tokens + run.inputTokens + run.outputTokens,
				unpriced: sum.unpriced + (run.costUsd === null ? 1 : 0),
				isPartial: sum.isPartial,
			}),
			{ costUsd: 0, invocations: 0, tokens: 0, unpriced: 0, isPartial },
		)
}

// FINDINGS LIST

export type StatusTab = NonNullable<SecurityFindingsSearch["status"]>

export const STATUS_TABS: ReadonlyArray<StatusTab> = ["open", "fixed", "dismissed", "accepted_risk", "all"]

export const statusTabOf = (search: SecurityFindingsSearch): StatusTab => search.status ?? "open"

const matchesStatus = (status: SecurityAuditFindingStatus, tab: StatusTab) => tab === "all" || status === tab

export const countForTab = (findings: ReadonlyArray<SecurityAuditFinding>, tab: StatusTab): number =>
	findings.filter((finding) => finding.verdict !== "rejected" && matchesStatus(finding.status, tab)).length

const matchesQuery = (finding: SecurityAuditFinding, query: string): boolean => {
	if (query === "") return true
	const haystack = [finding.record.title, locationOf(finding.record) ?? "", finding.fingerprint]
		.join("\n")
		.toLowerCase()
	return haystack.includes(query.toLowerCase())
}

/** The rows the toolbar leaves, before grouping. */
export const filteredFindings = (
	findings: ReadonlyArray<SecurityAuditFinding>,
	search: SecurityFindingsSearch,
	query: string,
): ReadonlyArray<SecurityAuditFinding> => {
	const tab = statusTabOf(search)
	return findings.filter(
		(finding) =>
			matchesStatus(finding.status, tab) &&
			(search.severity === undefined || finding.overallSeverity === search.severity) &&
			(search.verdict === undefined ||
				finding.verdict === search.verdict ||
				finding.verdict === "rejected") &&
			(search.rejected === true || finding.verdict !== "rejected") &&
			(search.target === undefined || finding.targetId === search.target) &&
			matchesQuery(finding, query.trim()),
	)
}

export const groupFindings = (
	findings: ReadonlyArray<SecurityAuditFinding>,
): ReadonlyArray<Readonly<{ group: FindingGroup; rows: ReadonlyArray<SecurityAuditFinding> }>> =>
	(["confirmed", "needs_validation", "rejected"] as const)
		.map((group) => ({
			group,
			rows: findings.filter((finding) => finding.verdict === group).sort(bySeverity),
		}))
		.filter((entry) => entry.rows.length > 0)

/** The first rows of a group before "Show all". */
export const GROUP_PAGE = 7

/** New: first reported in the last day. */
export const isNewFinding = (finding: SecurityAuditFinding, nowMs: number): boolean =>
	finding.status === "open" && nowMs - finding.createdAt < 24 * 60 * 60 * 1000

/** A finding a later run marked fixed that came back. */
export const isReopened = (finding: SecurityAuditFinding): boolean =>
	finding.status === "open" && finding.fixedRunId !== null
