import {
	AuditDetectionFilters,
	AuditTrailCategory,
	AuditTrailOutcome,
	AuditTrailProvider,
} from "@maple/domain/audit-trail"
import {
	type AlertRuleId,
	type AuditDetection,
	AuditDetectionCreateRequest,
	type AuditDetectionListResponse,
} from "@maple/domain/http"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import type { SecurityDetectionNewSearch } from "../../../route/search"
import { type DetectionTemplate, DETECTION_TEMPLATES, templateOf } from "../kit/detection-templates"
import { emptyForm, type Form } from "./form"

const isProvider = Schema.is(AuditTrailProvider)
const isCategory = Schema.is(AuditTrailCategory)
const isOutcome = Schema.is(AuditTrailOutcome)

// The request schema is the one source of the bounds: a field is valid when the API would take it.
const fields = AuditDetectionCreateRequest.fields
const isName = Schema.is(fields.name)
const isThreshold = Schema.is(fields.threshold)
const isWindow = Schema.is(fields.windowMinutes)
const isFilters = Schema.is(AuditDetectionFilters)

const numberOf = (raw: string, isValid: (value: number) => boolean): Option.Option<number> => {
	const text = Str.trim(raw)
	const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
	return isValid(value) ? Option.some(value) : Option.none()
}

/** The count typed, when it is a whole number the API takes (1 to 100,000). */
export const thresholdOf = (form: Form): Option.Option<number> => numberOf(form.threshold, isThreshold)

/** The window typed, in minutes, when the API takes it (5 minutes to 24 hours). */
export const windowOf = (form: Form): Option.Option<number> => numberOf(form.windowMinutes, isWindow)

/** What the form counts. A select value this build has no name for counts as "Any". */
export const filtersOf = (form: Form): AuditDetectionFilters => {
	const action = Str.trim(form.action)
	return {
		...(isProvider(form.provider) ? { provider: form.provider } : undefined),
		...(isCategory(form.category) ? { category: form.category } : undefined),
		...(isOutcome(form.outcome) ? { outcome: form.outcome } : undefined),
		...(action === "" ? undefined : { action }),
	}
}

/** What still blocks saving, one sentence each. The bounds are the request schema's. */
export const formIssues = (form: Form): ReadonlyArray<string> => {
	const name = Str.trim(form.name)
	return [
		...(name === "" ? ["Name the detection."] : []),
		...(name !== "" && !isName(name) ? ["Keep the name to 120 characters."] : []),
		// The selects only hold values the schema knows, so the action is what can be out of bounds.
		...(isFilters(filtersOf(form)) ? [] : ["Keep the action to 256 characters."]),
		...(Option.isNone(thresholdOf(form)) ? ["Set a count from 1 to 100,000."] : []),
		...(Option.isNone(windowOf(form)) ? ["Set a window from 5 to 1,440 minutes."] : []),
		...(Schema.is(fields.destinationIds)(form.destinationIds) ? [] : ["Notify at most 20 destinations."]),
	]
}

/** The create body, also sent whole on an edit: `filters` replaces the stored ones. */
export const wirePayload = (form: Form): AuditDetectionCreateRequest => ({
	name: Str.trim(form.name),
	enabled: form.enabled,
	filters: filtersOf(form),
	windowMinutes: Option.getOrElse(windowOf(form), () => 0),
	threshold: Option.getOrElse(thresholdOf(form), () => 0),
	severity: form.severity,
	destinationIds: form.destinationIds,
})

export const formFromDetection = (detection: AuditDetection): Form => ({
	name: detection.name,
	provider: detection.filters.provider ?? "",
	category: detection.filters.category ?? "",
	outcome: detection.filters.outcome ?? "",
	action: detection.filters.action ?? "",
	threshold: String(detection.threshold),
	windowMinutes: String(detection.windowMinutes),
	severity: detection.severity,
	destinationIds: detection.destinationIds,
	enabled: detection.enabled,
})

const isTemplateTitle = (name: string): boolean =>
	Arr.some(DETECTION_TEMPLATES, (template) => template.title === name)

/**
 * `form` started over from `template`: what it counts, when it fires and how severe. A name the
 * user typed stays; the destinations and the switch are theirs too.
 */
export const withTemplate = (form: Form, template: DetectionTemplate): Form => ({
	...form,
	name: Str.trim(form.name) === "" || isTemplateTitle(form.name) ? template.title : form.name,
	provider: template.filters.provider ?? "",
	category: template.filters.category ?? "",
	outcome: template.filters.outcome ?? "",
	action: template.filters.action ?? "",
	threshold: String(template.threshold),
	windowMinutes: String(template.windowMinutes),
	severity: template.severity,
})

/**
 * `form` with what a template set put back to a blank detection's. A name the user typed stays,
 * like the destinations and the switch.
 */
export const withoutTemplate = (form: Form): Form => {
	const blank = emptyForm()
	return {
		...form,
		name: isTemplateTitle(form.name) ? blank.name : form.name,
		provider: blank.provider,
		category: blank.category,
		outcome: blank.outcome,
		action: blank.action,
		threshold: blank.threshold,
		windowMinutes: blank.windowMinutes,
		severity: blank.severity,
	}
}

/**
 * The form a link prefills: a ready-made template, then the audit log's filters over it. A
 * platform, category or outcome this build has no name for is dropped, not sent to the API.
 */
export const formFromSearch = (search: SecurityDetectionNewSearch): Form => {
	const base = Option.match(templateOf(search.template), {
		onNone: () => emptyForm(),
		onSome: (template) => withTemplate(emptyForm(), template),
	})
	return {
		...base,
		...(isProvider(search.provider) ? { provider: search.provider } : undefined),
		...(isCategory(search.category) ? { category: search.category } : undefined),
		...(isOutcome(search.outcome) ? { outcome: search.outcome } : undefined),
		...(search.action === undefined ? undefined : { action: Str.trim(search.action) }),
	}
}

/** The detection the editor is on, once the list that holds it answered. */
export const detectionIn = (
	list: AuditDetectionListResponse,
	id: AlertRuleId | null,
): Option.Option<AuditDetection> => Arr.findFirst(list.detections, (detection) => detection.id === id)
