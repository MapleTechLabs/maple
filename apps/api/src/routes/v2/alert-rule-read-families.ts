import type { AlertRuleUpsertRequest } from "@maple/domain/http"
import { TELEMETRY_READ_FAMILIES } from "@maple/domain/http/v2"
import { Array as Arr } from "effect"

type TelemetryFamily = (typeof TELEMETRY_READ_FAMILIES)[number]

const isTelemetryFamily = (source: string): source is TelemetryFamily =>
	Arr.some(TELEMETRY_READ_FAMILIES, (family) => family === source)

/** The telemetry a rule's query reads. Raw SQL, and a source that is not a family, read all of it. */
export const ruleReadFamilies = (
	rule: Pick<AlertRuleUpsertRequest, "signalType" | "queryBuilderDraft">,
): ReadonlyArray<TelemetryFamily> => {
	switch (rule.signalType) {
		case "error_rate":
		case "p95_latency":
		case "p99_latency":
		case "apdex":
		case "throughput":
			return ["traces"]
		// No query of their own: an anomaly rule reads open incidents, and uptime, SLO and
		// audit detection rules are refused by the generic rule APIs before anything runs.
		case "anomaly":
		case "uptime":
		case "slo_burn_rate":
		case "audit":
			return []
		case "builder_query": {
			const source = rule.queryBuilderDraft?.dataSource
			return source !== undefined && isTelemetryFamily(source) ? [source] : TELEMETRY_READ_FAMILIES
		}
		case "raw_query":
			return TELEMETRY_READ_FAMILIES
	}
}
