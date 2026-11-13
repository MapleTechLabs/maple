import type { AlertIncidentDocument, ErrorIssueDocument } from "@maple/domain/http"
import { countLabel, pluralize } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { rowsToAlertIncidentDocuments } from "@maple/web-data/collections/alerts"
import type { ErrorByType } from "@maple/web-data/warehouse/errors"
import { Option, Order, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { isBudgetSpent, isBurning } from "../../alerts/shared/slo-derive"
import { sortIncidents } from "../../alerts/shared/sort"
import { GENERIC_TYPES } from "../../errors/hub/view-signal"
import { buildErrorSignals, type ErrorSignal } from "../../errors/kit/error-signal"
import { displayStatus, type UptimeMonitor } from "../../kit/uptime/derive"
import type { Model, SloRow, TopError } from "./model"

/** Rows a section lists before its footer link takes over. */
export const SECTION_ROWS = 5
/** How many of the window's fingerprints are ranked to find the open issues among them. */
export const RANK_LIMIT = 25

/** One read as the page shows it: still out, failed, or answered. */
export type Part<A> =
	| Readonly<{ _tag: "Loading" }>
	| Readonly<{ _tag: "Failed" }>
	| Readonly<{ _tag: "Ready"; value: A }>

const LOADING: Part<never> = { _tag: "Loading" }
const FAILED: Part<never> = { _tag: "Failed" }
const ready = <A>(value: A): Part<A> => ({ _tag: "Ready", value })

const partOf = <A, E, B>(data: AsyncData.AsyncData<A, E>, read: (value: A) => Part<B>): Part<B> =>
	Option.match(AsyncData.getData(data), {
		onNone: () => (AsyncData.isFailure(data) ? FAILED : LOADING),
		onSome: read,
	})

export type IncidentsSummary = Readonly<{
	/** Open incidents, critical first, then the latest trigger. */
	open: ReadonlyArray<AlertIncidentDocument>
	critical: number
	/** The org has alert rules (or had incidents); an unreadable rule count reads as set up. */
	isSetUp: boolean
}>

export const incidentsOf = (model: Model): Part<IncidentsSummary> =>
	partOf(model.incidents, (rows) => {
		const open = sortIncidents(
			Arr.filter(rowsToAlertIncidentDocuments(rows), (incident) => incident.status === "open"),
		)
		const summary = (isSetUp: boolean): Part<IncidentsSummary> =>
			ready({
				open,
				critical: Arr.filter(open, (incident) => incident.severity === "critical").length,
				isSetUp,
			})
		if (rows.length > 0) return summary(true)
		// No incident ever: whether that is "all quiet" or "no rules" waits for the rule count.
		return Option.match(AsyncData.getData(model.ruleCount), {
			onNone: () => (AsyncData.isFailure(model.ruleCount) ? summary(true) : LOADING),
			onSome: (count) => summary(count > 0),
		})
	})

export type UptimeSummary = Readonly<{
	/** Checks that are running and have reported: paused and pending ones are left out. */
	total: number
	passing: number
	/** Down first, then the ones whose latest checks failed. */
	failing: ReadonlyArray<UptimeMonitor>
	isSetUp: boolean
}>

export const uptimeOf = (model: Model): Part<UptimeSummary> =>
	partOf(model.monitors.data, (monitors) => {
		const withStatus = (status: ReturnType<typeof displayStatus>) =>
			Arr.filter(monitors, (monitor) => displayStatus(monitor) === status)
		const down = withStatus("down")
		const degraded = withStatus("degraded")
		const passing = withStatus("up").length
		return ready({
			total: passing + down.length + degraded.length,
			passing,
			failing: [...down, ...degraded],
			isSetUp: monitors.length > 0,
		})
	})

export type SloTrouble = Readonly<{
	slo: SloRow["slo"]
	state: "burning" | "spent"
	/** The share of the error budget left; negative once it is overspent. */
	budgetRemaining: number
}>

export type SlosSummary = Readonly<{
	total: number
	within: number
	/** Burning first, then the ones out of budget. */
	troubled: ReadonlyArray<SloTrouble>
	isSetUp: boolean
}>

export const slosOf = (model: Model): Part<SlosSummary> =>
	partOf(model.slos.data, (rows) => {
		// Every status arrives in one read: none at all means that read failed, not that all is well.
		if (rows.length > 0 && Arr.every(rows, (row) => row.status === null)) return FAILED
		const incidents = Option.getOrElse(AsyncData.getData(model.incidents), () => [])
		const troubleOf = (row: SloRow): ReadonlyArray<SloTrouble> => {
			if (row.status === null) return []
			const budgetRemaining = row.status.budget_remaining
			if (isBurning(row, incidents)) return [{ slo: row.slo, state: "burning", budgetRemaining }]
			return isBudgetSpent(budgetRemaining) ? [{ slo: row.slo, state: "spent", budgetRemaining }] : []
		}
		const troubled = Arr.flatMap(rows, troubleOf)
		const known = Arr.filter(rows, (row) => row.status !== null).length
		return ready({
			total: rows.length,
			within: known - troubled.length,
			troubled: [
				...Arr.filter(troubled, (trouble) => trouble.state === "burning"),
				...Arr.filter(troubled, (trouble) => trouble.state === "spent"),
			],
			isSetUp: rows.length > 0,
		})
	})

export type Verdict =
	| Readonly<{ _tag: "Loading" }>
	| Readonly<{
			_tag: "Ready"
			tone: Tone
			sentence: string
			/** The counts that back the sentence, one per source. */
			support: ReadonlyArray<string>
	  }>

const incidentsLine = (part: Part<IncidentsSummary>): string => {
	if (part._tag !== "Ready") return "Couldn't check incidents"
	const { open, critical, isSetUp } = part.value
	if (!isSetUp) return "No alert rules"
	if (open.length === 0) return "No open incidents"
	const count = `${open.length} open ${pluralize(open.length, "incident")}`
	return critical === 0 ? count : `${count}, ${critical} critical`
}

const uptimeLine = (part: Part<UptimeSummary>): string => {
	if (part._tag !== "Ready") return "Couldn't check uptime"
	const { total, passing, isSetUp } = part.value
	if (!isSetUp) return "No uptime checks"
	if (total === 0) return "No uptime checks running"
	return `${passing} of ${total} uptime ${pluralize(total, "check")} passing`
}

const slosLine = (part: Part<SlosSummary>): string => {
	if (part._tag !== "Ready") return "Couldn't check SLOs"
	const { total, within, isSetUp } = part.value
	return isSetUp ? `${within} of ${total} ${pluralize(total, "SLO")} within budget` : "No SLOs"
}

const listOf = (names: ReadonlyArray<string>): string =>
	names.length <= 1
		? Arr.join(names, "")
		: `${Arr.join(names.slice(0, -1), ", ")} and ${names[names.length - 1] ?? ""}`

/** What is wrong, in the order a reader should hear it: incidents, failing checks, SLOs. */
const problemsOf = (
	incidents: Part<IncidentsSummary>,
	uptime: Part<UptimeSummary>,
	slos: Part<SlosSummary>,
): ReadonlyArray<string> => {
	const open = incidents._tag === "Ready" ? incidents.value.open.length : 0
	const failing = uptime._tag === "Ready" ? uptime.value.failing.length : 0
	const troubled = slos._tag === "Ready" ? slos.value.troubled : []
	const burning = Arr.filter(troubled, (trouble) => trouble.state === "burning").length
	const spent = troubled.length - burning
	return [
		...(open > 0 ? [`${countLabel(open, "incident")} open.`] : []),
		...(failing > 0 ? [`${countLabel(failing, "check")} failing.`] : []),
		...(burning > 0 ? [`${countLabel(burning, "SLO")} burning.`] : []),
		...(spent > 0 ? [`${countLabel(spent, "SLO")} out of budget.`] : []),
	]
}

/** The page's one-sentence answer; no verdict until incidents, uptime and SLOs have all answered. */
export const verdictOf = (model: Model): Verdict => {
	const incidents = incidentsOf(model)
	const uptime = uptimeOf(model)
	const slos = slosOf(model)
	if (incidents._tag === "Loading" || uptime._tag === "Loading" || slos._tag === "Loading")
		return { _tag: "Loading" }
	const support = [incidentsLine(incidents), uptimeLine(uptime), slosLine(slos)]
	const problems = problemsOf(incidents, uptime, slos)
	if (problems.length > 0)
		return { _tag: "Ready", tone: "crit", sentence: Arr.join(problems, " "), support }
	const unchecked = [
		...(incidents._tag === "Failed" ? ["incidents"] : []),
		...(uptime._tag === "Failed" ? ["uptime"] : []),
		...(slos._tag === "Failed" ? ["SLOs"] : []),
	]
	if (unchecked.length === 3)
		return { _tag: "Ready", tone: "neutral", sentence: "Couldn't check the status.", support: [] }
	if (unchecked.length > 0)
		return {
			_tag: "Ready",
			tone: "neutral",
			sentence: `No problems found, but ${listOf(unchecked)} couldn't be checked.`,
			support,
		}
	const isAnySetUp =
		(incidents._tag === "Ready" && incidents.value.isSetUp) ||
		(uptime._tag === "Ready" && uptime.value.isSetUp) ||
		(slos._tag === "Ready" && slos.value.isSetUp)
	return isAnySetUp
		? { _tag: "Ready", tone: "ok", sentence: "Everything is working.", support }
		: {
				_tag: "Ready",
				tone: "neutral",
				sentence: "Nothing is monitored yet.",
				support: ["An engineer on your team can set up alert rules, uptime checks and SLOs."],
			}
}

const firstLine = (text: string): string => Str.trim(Str.split("\n")(text)[0] ?? "")

/** The Errors list's title rule: a generic type gives way to its message, any other leads it. */
const titleOf = (signal: ErrorSignal): string => {
	const message = firstLine(signal.detail)
	if (message === "") return signal.title
	return GENERIC_TYPES.has(signal.title) ? message : `${signal.title}: ${message}`
}

const byWindowCount = Order.flip(
	Order.mapInput(Order.Number, (signal: ErrorSignal) => signal.windowCount ?? 0),
)

/** The issues with the most events in the window, joined to their counts the way the Errors list joins them. */
export const topErrorsOf = (
	issues: ReadonlyArray<ErrorIssueDocument>,
	warehouse: ReadonlyArray<ErrorByType>,
): ReadonlyArray<TopError> => {
	const signals = buildErrorSignals({ issues, warehouse, spark: [], investigations: new Map() })
	const counted = Arr.filter(signals, (signal) => (signal.windowCount ?? 0) > 0)
	return Arr.map(Arr.take(Arr.sort(counted, byWindowCount), SECTION_ROWS), (signal): TopError => ({
		id: signal.id,
		title: titleOf(signal),
		serviceName: signal.serviceName,
		severity: signal.severity,
		count: signal.windowCount ?? 0,
		lastSeenAt: signal.lastSeenAt,
	}))
}
