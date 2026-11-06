import type { V2Slo } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr, Option, String as Str } from "effect"
import { type Form, TARGET_PRESETS, type TargetPick } from "./form"

// The SLO form's draft read back: the target it sets, what still blocks saving, and the payload.

const MIN_TARGET = 50
const MAX_TARGET = 99.999

const isPreset = (value: string): value is (typeof TARGET_PRESETS)[number] =>
	Arr.some(TARGET_PRESETS, (preset) => preset === value)

/** The target in percent, or none while the custom value is not a number in range. */
export const targetOf = (form: Form): Option.Option<number> => {
	const raw = form.target === "custom" ? Str.trim(form.customTarget) : form.target
	const value = raw === "" ? Number.NaN : Number(raw)
	return Number.isFinite(value) && value >= MIN_TARGET && value <= MAX_TARGET
		? Option.some(value)
		: Option.none()
}

/** The environments typed, trimmed, empty ones and repeats dropped. */
export const environmentsOf = (form: Form): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.filter(Arr.map(Str.split(",")(form.environments), Str.trim), (environment) => environment !== ""),
	)

/** What still blocks saving, one sentence each. */
export const formIssues = (form: Form): ReadonlyArray<string> => [
	...(Str.trim(form.name) === "" ? ["Name the SLO."] : []),
	...(Str.trim(form.serviceName) === "" ? ["Pick a service."] : []),
	...(Option.isNone(targetOf(form)) ? [`Set a target between ${MIN_TARGET}% and ${MAX_TARGET}%.`] : []),
]

const MINUTES_PER_DAY = 24 * 60

/** "43 minutes": the full outage the budget allows over the window, for the target's hint. */
export const budgetDowntime = (targetPercent: number, windowDays: number): string => {
	const minutes = (1 - targetPercent / 100) * windowDays * MINUTES_PER_DAY
	if (minutes < 1) return countLabel(Math.round(minutes * 60), "second")
	if (minutes < 120) return countLabel(Math.round(minutes), "minute")
	const hours = minutes / 60
	return hours < 48
		? countLabel(Number(hours.toFixed(1)), "hour")
		: countLabel(Number((hours / 24).toFixed(1)), "day")
}

/** The form the edited SLO fills: a target off the presets reads as custom. */
export const formFromSlo = (slo: V2Slo): Form => {
	const target = String(slo.target_percent)
	const pick: TargetPick = isPreset(target) ? target : "custom"
	return {
		name: slo.name,
		description: slo.description ?? "",
		serviceName: slo.service_name,
		environments: Arr.join(slo.environments, ", "),
		sliType: slo.sli.type,
		thresholdMs: slo.sli.type === "latency" ? slo.sli.threshold_ms : 500,
		target: pick,
		customTarget: pick === "custom" ? target : "",
		windowDays: slo.window_days,
		alertingEnabled: slo.alerting.enabled,
		criticalDestinationIds: slo.alerting.critical_destination_ids,
		warningDestinationIds: slo.alerting.warning_destination_ids,
	}
}

/** The create or update body as the wire takes it; `saveSlo` decodes it before it is sent. */
export const wirePayload = (form: Form) => ({
	name: Str.trim(form.name),
	description: Str.trim(form.description) === "" ? null : Str.trim(form.description),
	service_name: Str.trim(form.serviceName),
	environments: environmentsOf(form),
	sli:
		form.sliType === "availability"
			? { type: "availability" }
			: { type: "latency", threshold_ms: form.thresholdMs },
	target_percent: Option.getOrElse(targetOf(form), () => 0),
	window_days: form.windowDays,
	alerting: {
		enabled: form.alertingEnabled,
		critical_destination_ids: form.criticalDestinationIds,
		warning_destination_ids: form.warningDestinationIds,
	},
})
