import type {
	AlertDestinationId,
	AlertSeverity,
	AlertSignalType,
	AnomalySignalType,
} from "@maple/domain/http"
import { ANOMALY_SIGNALS } from "@maple/web-data/alerts/anomaly-rule"
import { switchSignalKind } from "@maple/web-data/alerts/rule-modes"
import { ALERT_TEMPLATES } from "../shared/templates"
import { suggestCriticalThreshold } from "./derive"
import { asFormState, fromFormState, type RuleForm } from "./form"
import type { SignalKind, TextField, Tier } from "./message"
import { Array as Arr, String as Str, Option } from "effect"

// The form edits each control makes (the `onChange((c) => ...)` callbacks), as pure steps.

export const setText = (form: RuleForm, field: TextField, value: string): RuleForm => ({
	...form,
	[field]: value,
})

export const setEscalationField = (
	form: RuleForm,
	field: "threshold" | "recoveryValue",
	value: string,
): RuleForm =>
	form.escalation === null ? form : { ...form, escalation: { ...form.escalation, [field]: value } }

/** `setKind`: the switch carries filters and the threshold's meaning, and may leave a notice. */
export const switchKind = (form: RuleForm, kind: SignalKind): { form: RuleForm; notice: string | null } => {
	const moved = switchSignalKind(asFormState(form), kind)
	return { form: fromFormState(moved.form), notice: moved.notice }
}

export const setBuiltinSignal = (form: RuleForm, signalType: AlertSignalType): RuleForm => ({
	...form,
	signalType,
})

export const setSeverity = (form: RuleForm, severity: AlertSeverity): RuleForm => ({ ...form, severity })

export const addCriticalTier = (form: RuleForm): RuleForm => ({
	...form,
	severity: "warning",
	escalation: { threshold: suggestCriticalThreshold(form), recoveryValue: "", destinationIds: [] },
})

/** An anomaly rule's signal toggled in or out of its scope, kept in the editor's order. */
export const toggleAnomalySignal = (form: RuleForm, signal: AnomalySignalType): RuleForm => ({
	...form,
	anomalySignals: form.anomalySignals.includes(signal)
		? Arr.filter(form.anomalySignals, (existing) => existing !== signal)
		: Arr.filter(
				ANOMALY_SIGNALS,
				(candidate) => candidate === signal || form.anomalySignals.includes(candidate),
			),
})

/** Services: each named service is already its own group, and exclude only narrows "all services". */
export const setServices = (form: RuleForm, serviceNames: ReadonlyArray<string>): RuleForm => ({
	...form,
	serviceNames: [...serviceNames],
	groupBy: serviceNames.length > 0 ? [] : form.groupBy,
	excludeServiceNames: serviceNames.length > 0 ? [] : form.excludeServiceNames,
})

/** A chip picker's selection written to its field, by picker id. */
export const setChips = (form: RuleForm, id: string, values: ReadonlyArray<string>): RuleForm => {
	switch (id) {
		case "rule-services":
			return setServices(form, values)
		case "rule-environments":
			return { ...form, environments: [...values] }
		case "rule-group-by":
			return { ...form, groupBy: [...values] }
		case "rule-exclude":
			return { ...form, excludeServiceNames: [...values] }
		default:
			return form
	}
}

/** The tier's destination ids updated (`setIds`). */
export const updateTierIds = (
	form: RuleForm,
	tier: Tier,
	update: (ids: ReadonlyArray<AlertDestinationId>) => ReadonlyArray<AlertDestinationId>,
): RuleForm =>
	tier === "warning"
		? { ...form, destinationIds: [...update(form.destinationIds)] }
		: form.escalation === null
			? form
			: {
					...form,
					escalation: {
						...form.escalation,
						destinationIds: [...update(form.escalation.destinationIds)],
					},
				}

/**
 * A destination picked for a tier joins it. On an anomaly rule it also leaves the other tier:
 * critical anomaly pages already reach the warning destinations, so being on both only doubles
 * the page. A threshold rule keeps it on both, since each of its tiers needs its own destinations.
 */
export const assignToTier = (form: RuleForm, tier: Tier, id: AlertDestinationId): RuleForm =>
	updateTierIds(
		form.signalType === "anomaly"
			? updateTierIds(form, tier === "warning" ? "critical" : "warning", removeId(id))
			: form,
		tier,
		addId(id),
	)

export const addId = (id: AlertDestinationId) => (ids: ReadonlyArray<AlertDestinationId>) => [
	...new Set([...ids, id]),
]
export const removeId = (id: AlertDestinationId) => (ids: ReadonlyArray<AlertDestinationId>) =>
	Arr.filter(ids, (existing) => existing !== id)

/** `onPick`: templates fill the query builder; Apdex has no builder aggregation, so it stays Built-in. */
export const pickTemplate = (form: RuleForm, templateId: string): RuleForm => {
	const template = Arr.findFirst(ALERT_TEMPLATES, (candidate) => candidate.id === templateId)
	if (Option.isNone(template)) return form
	const applied = fromFormState(template.value.apply(form))
	return applied.signalType === "apdex" ? applied : switchKind(applied, "builder_query").form
}

// `TagInput`'s limits and `canonicalize`.
const MAX_TAGS = 20
const MAX_TAG_LENGTH = 32

/** `commit`: the draft as a canonical tag, unless empty, already there, or over the limit. */
export const commitTag = (form: RuleForm, raw: string): RuleForm => {
	const tag = Str.slice(0, MAX_TAG_LENGTH)(Str.toLowerCase(Str.trim(raw)))
	if (tag.length === 0 || form.tags.includes(tag) || form.tags.length >= MAX_TAGS) return form
	return { ...form, tags: [...form.tags, tag] }
}

export const removeTag = (form: RuleForm, tag: string): RuleForm => ({
	...form,
	tags: Arr.filter(form.tags, (existing) => existing !== tag),
})

/** `appendToBody`: a variable token after the body, space-separated. */
export const appendVariable = (form: RuleForm, key: string): RuleForm => {
	const token = `{{ ${key} }}`
	return {
		...form,
		notificationBody: form.notificationBody.length > 0 ? `${form.notificationBody} ${token}` : token,
	}
}
