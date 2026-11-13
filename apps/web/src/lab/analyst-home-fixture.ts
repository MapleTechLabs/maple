import { OrgId } from "@maple/domain"
import type { V2UptimeMonitor } from "@maple/domain/http/v2"
import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import { Result, Schema, Array as Arr } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { SignalPresences } from "@maple/views/data/signal-presence"
import { checkoutSlo, searchSlo, sloStatus, sloUuid } from "../page/alerts/shared/slo-test-fixtures"
import type { PageContext } from "../page/contract"
import { incidentRow, NOW, ORG, ruleId } from "../page/kit/alert-test-rows"
import { downMonitor, httpMonitor, monitorId } from "../page/kit/uptime/test-monitors"
import { topErrorsOf } from "../page/overview/analyst/derive"
import { Message } from "../page/overview/analyst/message"
import type { Model, SloRow, TopError } from "../page/overview/analyst/model"
import { init, update } from "../page/overview/analyst/update"
import { buildErrorsLabFixture } from "./errors-fixture"

// The analyst Overview's fixtures, shared by `/lab/analyst-home` and its scene tests.

export const STATES = ["clear", "attention", "empty", "loading", "failed"] as const
export type AnalystHomeState = (typeof STATES)[number]

export const ANALYST_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	pinnedNamespace: null,
	timeZone: "UTC",
	audience: "analyst",
}

const MINUTE = 60_000
const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString()

export const CRITICAL_INCIDENT = incidentRow({
	rule_name: "Checkout p95 latency",
	group_key: "checkout-api",
})
export const WARNING_INCIDENT = incidentRow({
	id: "0199a003-0000-7000-8000-000000000002",
	rule_id: ruleId(3),
	incident_key: "rule-3:all",
	dedupe_key: "rule-3:all",
	rule_name: "Search error rate",
	group_key: "search-api",
	signal_type: "error_rate",
	severity: "warning",
	threshold: 0.02,
	last_observed_value: 0.034,
	first_triggered_at: iso(26 * MINUTE),
	last_triggered_at: iso(2 * MINUTE),
})

const UP_MONITORS: ReadonlyArray<V2UptimeMonitor> = Arr.map(
	["checkout-api", "search-api", "Marketing site", "Customer dashboard", "Public API"],
	(name, index) => httpMonitor({ id: monitorId(index + 4), name }),
)
export const DOWN_MONITOR = downMonitor()

const HEALTHY_SLOS: ReadonlyArray<SloRow> = [
	{ slo: checkoutSlo(), status: sloStatus("healthy") },
	{ slo: searchSlo(), status: sloStatus("healthy", { sloId: sloUuid(2), targetPercent: 99.5 }) },
]
const TROUBLED_SLOS: ReadonlyArray<SloRow> = [
	{ slo: checkoutSlo(), status: sloStatus("burning") },
	{ slo: searchSlo(), status: sloStatus("exhausted", { sloId: sloUuid(2), targetPercent: 99.5 }) },
]

const errorsFixture = buildErrorsLabFixture(NOW)

/** The Errors lab's issues, ranked and joined the way the page's own read joins them. */
export const TOP_ERRORS: ReadonlyArray<TopError> = topErrorsOf(
	Arr.map(errorsFixture.signals, (signal) => signal.issue),
	Arr.flatMap(errorsFixture.signals, (signal) =>
		signal.windowCount === null
			? []
			: [
					{
						fingerprintHash: signal.fingerprintHash,
						errorLabel: signal.title,
						sampleMessage: signal.detail,
						count: signal.windowCount,
						affectedServicesCount: signal.affectedServicesCount ?? 1,
						firstSeen: new Date(signal.firstSeenAt),
						lastSeen: new Date(signal.lastSeenAt),
					},
				],
	),
)

type Data = Readonly<{
	rules: number
	incidents: ReadonlyArray<AlertIncidentRow>
	/** `null`: the uptime read fails. */
	monitors: ReadonlyArray<V2UptimeMonitor> | null
	slos: ReadonlyArray<SloRow>
	errors: ReadonlyArray<TopError>
	traces: "present" | "absent"
}>

const CLEAR: Data = {
	rules: 6,
	incidents: [],
	monitors: UP_MONITORS,
	slos: HEALTHY_SLOS,
	errors: TOP_ERRORS,
	traces: "present",
}

const DATA = {
	clear: CLEAR,
	attention: {
		...CLEAR,
		incidents: [WARNING_INCIDENT, CRITICAL_INCIDENT],
		monitors: [...UP_MONITORS, DOWN_MONITOR],
		slos: TROUBLED_SLOS,
	},
	empty: { rules: 0, incidents: [], monitors: [], slos: [], errors: [], traces: "absent" },
	failed: { ...CLEAR, monitors: null },
} as const satisfies Record<Exclude<AnalystHomeState, "loading">, Data>

const presences = (traces: Data["traces"]): SignalPresences => ({
	traces: { status: traces, lastSeenMs: traces === "present" ? NOW - MINUTE : null },
})

const step = (model: Model, message: Message): Model => update(model, message, ANALYST_CONTEXT).model

/** The page as its reads leave it in `state`, on the fixtures' fixed clock. */
export const analystHomeModel = (state: AnalystHomeState): Model => {
	const entered = step(init(ANALYST_CONTEXT).model, Message.CompletedReadClock({ nowMs: NOW }))
	if (state === "loading") return entered
	const data: Data = DATA[state]
	const answers: ReadonlyArray<(model: Model) => Message> = [
		() => Message.UpdatedRules({ orgId: ORG, count: data.rules }),
		() => Message.UpdatedIncidents({ orgId: ORG, rows: data.incidents }),
		(model) =>
			Message.CompletedFetchMonitors({
				key: model.monitors.key ?? "",
				result:
					data.monitors === null
						? Result.fail(toLoadFailure("The request timed out"))
						: Result.succeed(data.monitors),
			}),
		(model) =>
			Message.CompletedFetchSlos({ key: model.slos.key ?? "", result: Result.succeed(data.slos) }),
		(model) =>
			Message.CompletedFetchErrors({
				key: model.errors.key ?? "",
				result: Result.succeed(data.errors),
			}),
		() => Message.CompletedLoadSignalPresence({ result: Result.succeed(presences(data.traces)) }),
	]
	return Arr.reduce(answers, entered, (model, answer) => step(model, answer(model)))
}
