import type { RuleFormState } from "@maple/web-data/alerts/form-utils"
import type { IconName } from "../../../ui/icon"

// `ALERT_TEMPLATES`; each icon is its generated name.

export type AlertTemplateId = "high_error_rate" | "slow_p95" | "slow_p99" | "low_apdex" | "throughput_drop"

export interface AlertTemplate {
	readonly id: AlertTemplateId
	readonly title: string
	readonly description: string
	readonly summary: string
	readonly icon: IconName
	readonly apply: (base: RuleFormState) => RuleFormState
}

export const ALERT_TEMPLATES: ReadonlyArray<AlertTemplate> = [
	{
		id: "high_error_rate",
		title: "High error rate",
		description: "Catch error-rate spikes on root spans before users do.",
		summary: "error rate > 5% / 5min",
		icon: "FireIcon",
		apply: (base) => ({
			...base,
			name: base.name || "High error rate",
			signalType: "error_rate",
			comparator: "gt",
			threshold: "5",
			windowMinutes: "5",
			groupBy:
				base.serviceNames.length > 0 || base.groupBy.length > 0 ? base.groupBy : ["service.name"],
		}),
	},
	{
		id: "slow_p95",
		title: "Slow P95 latency",
		description: "Page on tail-latency regressions for root spans.",
		summary: "P95 > 1000ms / 5min",
		icon: "ClockIcon",
		apply: (base) => ({
			...base,
			name: base.name || "Slow P95 latency",
			signalType: "p95_latency",
			comparator: "gt",
			threshold: "1000",
			windowMinutes: "5",
		}),
	},
	{
		id: "slow_p99",
		title: "Slow P99 latency",
		description: "Bound the very worst request you'll tolerate.",
		summary: "P99 > 2000ms / 5min",
		icon: "StopwatchIcon",
		apply: (base) => ({
			...base,
			name: base.name || "Slow P99 latency",
			signalType: "p99_latency",
			comparator: "gt",
			threshold: "2000",
			windowMinutes: "5",
		}),
	},
	{
		id: "low_apdex",
		title: "Low Apdex score",
		description: "User-satisfaction drop against a 500ms response target.",
		summary: "Apdex < 0.8 / 5min",
		icon: "CirclePercentageIcon",
		apply: (base) => ({
			...base,
			name: base.name || "Low Apdex score",
			signalType: "apdex",
			comparator: "lt",
			threshold: "0.8",
			apdexThresholdMs: "500",
			windowMinutes: "5",
		}),
	},
	{
		id: "throughput_drop",
		title: "Throughput drop",
		description: "Wake up when traffic falls off a cliff.",
		summary: "throughput < 100 / 5min",
		icon: "PulseIcon",
		apply: (base) => ({
			...base,
			name: base.name || "Throughput drop",
			signalType: "throughput",
			comparator: "lt",
			threshold: "100",
			windowMinutes: "5",
			minimumSampleCount: "0",
		}),
	},
]
