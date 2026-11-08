import { SLO_LATENCY_THRESHOLDS_MS, SloLatencyThresholdMs, SloWindowDays } from "@maple/domain"
import { AlertDestinationId } from "@maple/domain/http"
import { Schema } from "effect"

// The SLO form's draft: every field as the inputs hold it, strings until the payload is built.

export const SliType = Schema.Literals(["availability", "latency"])
export type SliType = typeof SliType.Type

/** The free-text inputs, addressed by name from one Message. */
export const TextField = Schema.Literals([
	"name",
	"description",
	"serviceName",
	"environments",
	"customTarget",
])
export type TextField = typeof TextField.Type

/** The target presets, in percent; `custom` reads `customTarget`. */
export const TARGET_PRESETS = ["99", "99.5", "99.9", "99.95", "99.99"] as const
export const TargetPick = Schema.Literals([...TARGET_PRESETS, "custom"])
export type TargetPick = typeof TargetPick.Type

export const WINDOW_DAYS = SloWindowDays.literals

export const THRESHOLDS = SLO_LATENCY_THRESHOLDS_MS

export const Tier = Schema.Literals(["critical", "warning"])
export type Tier = typeof Tier.Type

export const Form = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	serviceName: Schema.String,
	/** Comma-separated; empty counts every environment. */
	environments: Schema.String,
	sliType: SliType,
	thresholdMs: SloLatencyThresholdMs,
	target: TargetPick,
	customTarget: Schema.String,
	windowDays: SloWindowDays,
	alertingEnabled: Schema.Boolean,
	criticalDestinationIds: Schema.Array(AlertDestinationId),
	warningDestinationIds: Schema.Array(AlertDestinationId),
})
export type Form = typeof Form.Type

/** A new SLO: availability at 99.9% over 30 days, alerting on with nobody notified yet. */
export const emptyForm = (fields: Partial<Form> = {}): Form => ({
	name: "",
	description: "",
	serviceName: "",
	environments: "",
	sliType: "availability",
	thresholdMs: 500,
	target: "99.9",
	customTarget: "",
	windowDays: 30,
	alertingEnabled: true,
	criticalDestinationIds: [],
	warningDestinationIds: [],
	...fields,
})
