import type { V2ScrapeTarget, V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { FlowContext, FlowSpec, LiveHealth } from "./flow"
import type { Model } from "./model"
import { hostnameOf } from "./prometheus"
import { isFormValid, parsedInterval, prometheusTargets } from "./update-prometheus"

// Prometheus and WarpStream in the connect flow: save an endpoint and probe it, name it, then
// watch the first scheduled scrape. WarpStream clusters are scraped as Prometheus targets.

export type ScrapeIntegration = "prometheus" | "warpstream"

/** The target this visit saved: a save selects it, and nothing else selects one on this page. */
export const flowTarget = (model: Model): V2ScrapeTarget | null => {
	const id = model.prometheusCard.selectedId
	return id === null ? null : (prometheusTargets(model).find((target) => target.id === id) ?? null)
}

export type ProbeState =
	| Readonly<{ _tag: "Idle" }>
	| Readonly<{ _tag: "Saving" }>
	| Readonly<{ _tag: "Probing" }>
	| Readonly<{ _tag: "Ok" }>
	| Readonly<{ _tag: "Failed"; error: string }>

/** Connect's status: this visit's probe answer, else what the target's own last scrape says. */
export const probeStateOf = (model: Model, target: V2ScrapeTarget | null): ProbeState => {
	const card = model.prometheusCard
	if (card.isSaving) return { _tag: "Saving" }
	if (target === null) return { _tag: "Idle" }
	if (card.probing.includes(target.id)) return { _tag: "Probing" }
	const probe = card.probes[target.id]
	if (probe !== undefined)
		return probe.success ? { _tag: "Ok" } : { _tag: "Failed", error: probe.error ?? "The probe failed." }
	if (target.last_scrape_error !== null) return { _tag: "Failed", error: target.last_scrape_error }
	return target.last_scrape_at === null ? { _tag: "Probing" } : { _tag: "Ok" }
}

/** Choose data's form matches what is saved, so Continue does not drop an edit. */
export const isChoiceSaved = (model: Model, target: V2ScrapeTarget): boolean => {
	const form = model.prometheusCard.form
	return (
		form.name.value.trim() === target.name &&
		form.serviceName.value.trim() === (target.service_name ?? "") &&
		parsedInterval(form) === target.scrape_interval_seconds
	)
}

/** The selected target's newest scheduled check (probes are not in the history). */
export const latestCheck = (model: Model): V2ScrapeTargetCheck | null =>
	Option.match(AsyncData.getData(model.prometheusCard.checks.data), {
		onNone: () => null,
		onSome: (checks) => checks[0] ?? null,
	})

export const scrapeLiveHealth = (model: Model, target: V2ScrapeTarget | null): LiveHealth => {
	if (target === null) return "pending"
	const latest = latestCheck(model)
	if (!target.enabled || (latest !== null && !latest.success)) return "attention"
	return latest === null ? "pending" : "healthy"
}

export const prometheusFlow = (
	model: Model,
	integration: ScrapeIntegration,
	context: FlowContext,
): FlowSpec => {
	const target = flowTarget(model)
	const probe = probeStateOf(model, target)
	// WarpStream targets read as Prometheus ones, so only one added in this visit counts.
	const isOurs = integration === "prometheus" || context.hasAddedTarget
	const connected = target !== null && isOurs && probe._tag === "Ok" ? hostnameOf(target.url) : null
	const choiceSaved = target !== null && isChoiceSaved(model, target)
	const chosen =
		target !== null && connected !== null && choiceSaved
			? `${target.name}, every ${target.scrape_interval_seconds} s`
			: null
	const live = scrapeLiveHealth(model, target)
	return {
		stages: ["connect", "choose", "live"],
		connected,
		chosen,
		live,
		hint: {
			connect:
				probe._tag === "Saving" || probe._tag === "Probing"
					? "Waiting for the probe to finish."
					: probe._tag === "Failed"
						? "Continue unlocks once the probe succeeds."
						: connected === null
							? "Enter an endpoint URL to continue."
							: "Endpoint checked. Next, name it.",
			choose: model.prometheusCard.isSaving
				? "Saving."
				: !isFormValid(model.prometheusCard.form)
					? "Give the target a name and a 5 to 300 second interval."
					: choiceSaved
						? "Saved. Next, go live."
						: "Save your changes to continue.",
			live:
				live === "healthy"
					? "All checks passed."
					: live === "attention"
						? "The last scrape failed. Check the endpoint."
						: "Saved. Safe to leave while the first scrape runs.",
		},
	}
}
