import type { AlertRuleDocument, AnomalySignalType } from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"

/** Every detector signal, in the order the editor offers them. */
export const ANOMALY_SIGNALS: ReadonlyArray<AnomalySignalType> = [
	"error_rate",
	"latency_p95",
	"throughput",
	"error_spike",
	"log_volume",
]

/** A signal as the rule editor and the rules list name it. */
export const ANOMALY_SIGNAL_LABELS: Record<AnomalySignalType, string> = {
	error_rate: "Error rate",
	latency_p95: "p95 latency",
	throughput: "Throughput",
	error_spike: "Error spikes",
	log_volume: "Log volume",
} satisfies Record<AnomalySignalType, string>

/** What an anomaly rule pages on. Each empty list means every value. */
export type AnomalyRuleScope = Readonly<{
	serviceNames: ReadonlyArray<string>
	environments: ReadonlyArray<string>
	anomalySignals?: ReadonlyArray<AnomalySignalType> | undefined
}>

/** The org's default anomaly rule: an anomaly rule with no scope. The server keeps exactly one. */
export const isDefaultAnomalyRule = (
	rule: AnomalyRuleScope & Readonly<{ signalType: AlertRuleDocument["signalType"] }>,
): boolean =>
	rule.signalType === "anomaly" &&
	rule.serviceNames.length === 0 &&
	rule.environments.length === 0 &&
	(rule.anomalySignals ?? []).length === 0

const listOr = (values: ReadonlyArray<string>, all: string): string =>
	values.length === 0
		? all
		: values.length <= 2
			? Arr.join(values, ", ")
			: `${values.length} ${Str.replace(/^all /, "")(all)}`

/** "All services · production · Error rate, p95 latency": an anomaly rule's scope in one line. */
export const anomalyScopeSummary = (scope: AnomalyRuleScope): string =>
	Arr.join(
		[
			listOr(scope.serviceNames, "all services"),
			listOr(scope.environments, "all environments"),
			listOr(
				Arr.map(scope.anomalySignals ?? [], (signal) => ANOMALY_SIGNAL_LABELS[signal]),
				"all signals",
			),
		],
		" · ",
	)

/** The incident's severity in words: an anomaly rule observes 1 for warning and 2 for critical. */
export const anomalySeverityLabel = (value: number | null): string =>
	value === null ? "Normal" : value >= 2 ? "Critical" : value >= 1 ? "Warning" : "Normal"
