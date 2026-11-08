import type {
	GithubRepoSummary,
	SecurityAuditFinding,
	SecurityAuditRun,
	SecurityAuditRunDetail,
	SecurityAuditSettings,
	SecurityAuditTarget,
} from "@maple/domain/http"
import type { SecurityAuditFindingStatus } from "@maple/domain/security-audit"
import { Option, Array as Arr, Record as Rec, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "@maple/views/data/load-failure"
import type { SecurityFindingsSearch } from "../../../route/search"
import { type Gate, gateOf, isLive, isSameMonth, locationOf } from "../kit/format"
import { bucketOf, type BucketCounts, countsFromRun, isUnverified, SEVERITY_BUCKETS } from "../kit/findings"
import type { Model } from "./model"

// Pure readings of the tabs' Model: what each panel shows.

/** The repositories Add target offers: the connected installation's active ones. */
export const activeRepositoriesOf = (model: Model): ReadonlyArray<GithubRepoSummary> =>
	Option.match(AsyncData.getData(model.githubStatus.data), {
		onNone: () => [],
		onSome: (status) =>
			status.connected ? Arr.filter(status.repositories, (repo) => repo.status === "active") : [],
	})

/** A target's repository by id, "Removed target" once the target is gone. */
export const repositoryOf = (targets: ReadonlyArray<SecurityAuditTarget>, targetId: string): string =>
	Option.match(
		Arr.findFirst(targets, (target) => target.id === targetId),
		{ onNone: () => "Removed target", onSome: (target) => target.repository },
	)

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

/** Live runs in either list: polling keeps going while any is. */
export const runningRuns = (model: Model): ReadonlyArray<SecurityAuditRun> =>
	Arr.filter(allRuns(model), isLive)

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
	const slots = Arr.map(targets, (target) => model.findings[target.id])
	const failures = Arr.flatMap(slots, (slot) =>
		slot !== undefined && AsyncData.isFailure(slot.data) ? [slot.data.error] : [],
	)
	const gated = Arr.findFirst(failures, (failure) => Option.fromNullOr(gateOf(failure)))
	if (Option.isSome(gated)) return { _tag: "Gated", gate: gated.value }
	const failure = failures[0]
	if (failure !== undefined) return { _tag: "Failed", failure }
	if (!AsyncData.hasData(model.targets.data)) return { _tag: "Loading" }
	const loaded = Arr.map(slots, (slot) =>
		slot === undefined ? Option.none() : AsyncData.getData(slot.data),
	)
	if (Arr.some(loaded, Option.isNone)) return { _tag: "Loading" }
	return {
		_tag: "Ready",
		findings: Arr.flatMap(loaded, (response) =>
			Option.match(response, { onNone: () => [], onSome: (r) => r.findings }),
		),
		isRefreshing: Arr.some(slots, (slot) => slot !== undefined && AsyncData.isRefreshing(slot.data)),
	}
}

export const openConfirmed = (findings: ReadonlyArray<SecurityAuditFinding>) =>
	Arr.filter(findings, (finding) => finding.verdict === "confirmed" && finding.status === "open")

export const openNeedsValidation = (findings: ReadonlyArray<SecurityAuditFinding>) =>
	Arr.filter(findings, (finding) => finding.verdict === "needs_validation" && finding.status === "open")

/** Open leads, worst first: by severity, an estimate counting as one; proven before unverified at
 * the same level; unscored leads last; then by when they were last seen. */
export const openLeads = (
	findings: ReadonlyArray<SecurityAuditFinding>,
): ReadonlyArray<SecurityAuditFinding> =>
	[...openConfirmed(findings), ...openNeedsValidation(findings)].sort((a, b) => {
		const bySeverity = SEVERITY_BUCKETS.indexOf(bucketOf(a)) - SEVERITY_BUCKETS.indexOf(bucketOf(b))
		if (bySeverity !== 0) return bySeverity
		const byVerified = Number(isUnverified(a)) - Number(isUnverified(b))
		if (byVerified !== 0) return byVerified
		return b.updatedAt - a.updatedAt
	})

/** Closed units out of the ledger: what the run got to, whatever it found. */
const CLOSED_UNIT_STATUSES: ReadonlyArray<string> = ["covered", "candidate", "not_applicable", "out_of_scope"]

export const coverageOf = (detail: SecurityAuditRunDetail): Readonly<{ closed: number; total: number }> => ({
	closed: Arr.reduce(CLOSED_UNIT_STATUSES, 0, (sum, status) => sum + (detail.unitCounts[status] ?? 0)),
	total: detail.unitTotal,
})

/** Every target's latest ledger added up; null until one has units. */
export const coverageAcross = (
	model: Model,
): Readonly<{ closed: number; total: number; targets: number }> | null => {
	const details = Arr.flatMap(targetsOf(model), (target) => {
		const run = latestRunFor(model, target.id)
		const detail = run === undefined ? null : latestDetailOf(model, run.id)
		return detail === null || detail.unitTotal === 0 ? [] : [coverageOf(detail)]
	})
	return details.length === 0
		? null
		: Arr.reduce<(typeof details)[number], Readonly<{ closed: number; total: number; targets: number }>>(
				details,
				{ closed: 0, total: 0, targets: 0 },
				(sum, { closed, total }) => ({
					closed: sum.closed + closed,
					total: sum.total + total,
					targets: sum.targets + 1,
				}),
			)
}

/** Whether every read `coverageAcross` sums has landed: before that, "not mapped" would be a guess. */
export const coverageSettled = (model: Model): boolean =>
	Option.isSome(AsyncData.getData(model.targets.data)) &&
	Option.isSome(AsyncData.getData(model.runs.data)) &&
	Arr.every(targetsOf(model), (target) => {
		const run = latestRunFor(model, target.id)
		return run === undefined || latestDetailOf(model, run.id) !== null
	})

/** The API lists at most this many runs per request, newest first. */
export const RUN_LIST_CAP = 50

const targetRunsOf = (model: Model, targetId: string): ReadonlyArray<SecurityAuditRun> | null =>
	Option.getOrNull(
		Option.flatMap(Option.fromNullishOr(model.targetRuns[targetId]), (slot) =>
			AsyncData.getData(slot.data),
		),
	)?.runs ?? null

/** Of two copies of one run, the further along: finished beats live, then more agents run. */
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
		...Arr.reduce(lists.flat(), new Map<string, SecurityAuditRun>(), (byId, run) => {
			const held = byId.get(run.id)
			return byId.set(run.id, held === undefined ? run : fresher(held, run))
		}).values(),
	].sort((a, b) => b.startedAt - a.startedAt)

/** A target's runs: its own list and the polled global list together, so neither goes stale. */
export const runsForTarget = (model: Model, targetId: string): ReadonlyArray<SecurityAuditRun> =>
	mergeRuns([
		targetRunsOf(model, targetId) ?? [],
		Arr.filter(runsOf(model), (run) => run.targetId === targetId),
	])

/** Every run either list holds. */
export const allRuns = (model: Model): ReadonlyArray<SecurityAuditRun> =>
	mergeRuns([runsOf(model), ...Arr.map(targetsOf(model), (target) => targetRunsOf(model, target.id) ?? [])])

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

/** What a run reported, per severity, from whichever run list carries it; null for members. */
export const runCountsOf = (
	model: Model,
	runId: string,
): Readonly<{ buckets: BucketCounts; unverified: number }> | null => {
	const responses = [
		Option.getOrNull(AsyncData.getData(model.runs.data)),
		...Arr.map(Rec.values(model.targetRuns), (slot) => Option.getOrNull(AsyncData.getData(slot.data))),
	]
	return Option.getOrNull(
		Option.map(
			Arr.findFirst(responses, (response) => Option.fromUndefinedOr(response?.findingCounts?.[runId])),
			(counts) => ({ buckets: countsFromRun(counts), unverified: counts.unverified }),
		),
	)
}

/** The org's settings once read; null while loading or when the read failed. */
export const settingsOf = (model: Model): SecurityAuditSettings | null =>
	Option.getOrNull(AsyncData.getData(model.settings.data))

export type Spend = Readonly<{
	costUsd: number
	tokens: number
	/** Runs this month with no model cost recorded: only their sandbox fees are in `costUsd`. */
	unpriced: number
	/** A target's list hit the cap, so older runs of this month may be missing. */
	isPartial: boolean
}>

/** This month's runs across every target's own list (the global list stops at the cap). */
export const spendThisMonth = (model: Model): Spend => {
	const lists = Arr.map(targetsOf(model), (target) => targetRunsOf(model, target.id))
	const isPartial = Arr.some(lists, (runs) => runs === null || runs.length >= RUN_LIST_CAP)
	return Arr.reduce(
		Arr.filter(allRuns(model), (run) => isSameMonth(run.startedAt, model.nowMs)),
		{ costUsd: 0, tokens: 0, unpriced: 0, isPartial },
		(sum: Spend, run): Spend => ({
			costUsd: sum.costUsd + (run.costUsd ?? 0) + run.sandboxUsd,
			tokens: sum.tokens + run.inputTokens + run.outputTokens,
			unpriced: sum.unpriced + (run.costUsd === null ? 1 : 0),
			isPartial: sum.isPartial,
		}),
	)
}

// FINDINGS LIST

export type StatusTab = NonNullable<SecurityFindingsSearch["status"]>

export const STATUS_TABS: ReadonlyArray<StatusTab> = ["open", "fixed", "dismissed", "accepted_risk", "all"]

export const statusTabOf = (search: SecurityFindingsSearch): StatusTab => search.status ?? "open"

const matchesStatus = (status: SecurityAuditFindingStatus, tab: StatusTab) => tab === "all" || status === tab

export const countForTab = (findings: ReadonlyArray<SecurityAuditFinding>, tab: StatusTab): number =>
	Arr.filter(findings, (finding) => finding.verdict !== "rejected" && matchesStatus(finding.status, tab))
		.length

const matchesQuery = (finding: SecurityAuditFinding, query: string): boolean => {
	if (query === "") return true
	const haystack = Str.toLowerCase(
		Arr.join([finding.record.title, locationOf(finding.record) ?? "", finding.fingerprint], "\n"),
	)
	return Str.includes(Str.toLowerCase(query))(haystack)
}

/** The rows the toolbar leaves before the severity tile: what the tiles count. */
export const toolbarFindings = (
	findings: ReadonlyArray<SecurityAuditFinding>,
	search: SecurityFindingsSearch,
	query: string,
): ReadonlyArray<SecurityAuditFinding> => {
	const tab = statusTabOf(search)
	return Arr.filter(
		findings,
		(finding) =>
			matchesStatus(finding.status, tab) &&
			(search.rejected === true || finding.verdict !== "rejected") &&
			(search.target === undefined || finding.targetId === search.target) &&
			matchesQuery(finding, Str.trim(query)),
	)
}

/** The rows listed: the toolbar's, narrowed to the picked tile. A disproved row stays with "Show rejected". */
export const filteredFindings = (
	findings: ReadonlyArray<SecurityAuditFinding>,
	search: SecurityFindingsSearch,
	query: string,
): ReadonlyArray<SecurityAuditFinding> =>
	Arr.filter(
		toolbarFindings(findings, search, query),
		(finding) =>
			search.severity === undefined ||
			finding.verdict === "rejected" ||
			bucketOf(finding) === search.severity,
	)

/** New: first reported in the last day. */
export const isNewFinding = (finding: SecurityAuditFinding, nowMs: number): boolean =>
	finding.status === "open" && nowMs - finding.createdAt < 24 * 60 * 60 * 1000

/** A finding a later run marked fixed that came back. */
export const isReopened = (finding: SecurityAuditFinding): boolean =>
	finding.status === "open" && finding.fixedRunId !== null
