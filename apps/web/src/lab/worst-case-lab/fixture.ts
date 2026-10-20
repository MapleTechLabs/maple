import { initialsFrom } from "@maple/ui/lib/initials"
import { rulesFixture, WORST_CASE_PEOPLE } from "../worst-case-docs"
import { logs } from "../worst-case-fixture"
import { worstCaseTrace } from "../worst-case-trace"
import type { AlertsOverviewReady } from "@maple/web-data/alerts/overview"
import { Option, Schema } from "effect"
import type { ActorIdentity } from "../../page/errors/kit/actor"
import { TraceData } from "../../page/traces/detail/trace-data"
import { logTimeFormat, toLogRowView } from "../../ui/logs/log-row-view"
import type { LogRowView } from "../../ui/logs/log-row-view"
import type { WorstCaseMode } from "./model"

// The lab's reads of the `worst-case-*` fixtures, shaped for the views.

const DAY_MS = 24 * 60 * 60 * 1000

/** `MiscSection`'s `LogsTableView pinnedColumns`. */
export const PINNED_COLUMNS = ["db.user"]

export type LabTrace = Readonly<{ trace: TraceData; deepestSpanId: string }>

/** `worstCaseTrace(mode)` as the trace page's Model data, with the id `getSpanHierarchy` adds. */
export const traceOf = (mode: WorstCaseMode): Option.Option<LabTrace> => {
	const { detail, deepestSpanId } = worstCaseTrace(mode)
	return Option.map(
		Schema.decodeUnknownOption(TraceData)({ ...detail, traceId: detail.spans[0]?.traceId }),
		(trace) => ({ trace, deepestSpanId }),
	)
}

/** `actorIdentities(mode)`: every lab person is in the directory, so each resolves to its member. */
export const actorIdentities = (mode: WorstCaseMode): ReadonlyArray<ActorIdentity> =>
	WORST_CASE_PEOPLE[mode].map((person) => ({
		kind: "user",
		internal: false,
		name: person.name,
		detail: null,
		imageUrl: person.imageUrl,
		initials: initialsFrom(person.name),
		seed: person.userId,
	}))

/** `TablesSection`'s `RulesTab data`, its timeline ending at the boot clock. */
export const rulesOverview = (mode: WorstCaseMode, nowMs: number): AlertsOverviewReady => {
	const { rules, derived, states } = rulesFixture(mode)
	return {
		phase: "ready",
		rules,
		incidents: [],
		openIncidents: [],
		statesByRule: states,
		incidentsByRule: new Map(),
		derivedByRuleId: derived,
		healthCounts: { firing: 0, attention: 0, healthy: 0, disabled: 0 },
		timelineRange: { min: nowMs - DAY_MS, max: nowMs },
	}
}

/** The logs table's rows for a mode, in the browser's zone. */
export const logRows = (mode: WorstCaseMode, timeZone: string): ReadonlyArray<LogRowView> => {
	const time = logTimeFormat(timeZone)
	return logs(mode).map((log) => toLogRowView(log, PINNED_COLUMNS, time))
}
