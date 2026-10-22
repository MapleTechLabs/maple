import type { AlertDestinationId, AlertSeverity, AlertSignalType } from "@maple/domain/http"
import { switchSignalKind } from "@maple/web-data/alerts/rule-modes"
import { ALERT_TEMPLATES } from "../shared/templates"
import { suggestCriticalThreshold } from "./derive"
import { asFormState, fromFormState, type RuleForm } from "./form"
import type { SignalKind, TextField, Tier } from "./message"

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

export const addId = (id: AlertDestinationId) => (ids: ReadonlyArray<AlertDestinationId>) => [
	...new Set([...ids, id]),
]
export const removeId = (id: AlertDestinationId) => (ids: ReadonlyArray<AlertDestinationId>) =>
	ids.filter((existing) => existing !== id)

/** `onPick`: templates fill the query builder; Apdex has no builder aggregation, so it stays Built-in. */
export const pickTemplate = (form: RuleForm, templateId: string): RuleForm => {
	const template = ALERT_TEMPLATES.find((candidate) => candidate.id === templateId)
	if (template === undefined) return form
	const applied = fromFormState(template.apply(form))
	return applied.signalType === "apdex" ? applied : switchKind(applied, "builder_query").form
}

// `TagInput`'s limits and `canonicalize`.
const MAX_TAGS = 20
const MAX_TAG_LENGTH = 32

/** `commit`: the draft as a canonical tag, unless empty, already there, or over the limit. */
export const commitTag = (form: RuleForm, raw: string): RuleForm => {
	const tag = raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
	if (tag.length === 0 || form.tags.includes(tag) || form.tags.length >= MAX_TAGS) return form
	return { ...form, tags: [...form.tags, tag] }
}

export const removeTag = (form: RuleForm, tag: string): RuleForm => ({
	...form,
	tags: form.tags.filter((existing) => existing !== tag),
})

/** `appendToBody`: a variable token after the body, space-separated. */
export const appendVariable = (form: RuleForm, key: string): RuleForm => {
	const token = `{{ ${key} }}`
	return {
		...form,
		notificationBody: form.notificationBody.length > 0 ? `${form.notificationBody} ${token}` : token,
	}
}
