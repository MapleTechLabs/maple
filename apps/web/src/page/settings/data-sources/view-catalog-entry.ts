import type { V2CatalogEntry, V2CatalogField } from "@maple/domain/http/v2"
import { Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { badge } from "@maple/views/ui/display"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { field, fieldDescription, fieldLabel } from "@maple/views/ui/field"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { dividedList } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import { typography } from "@maple/views/ui/typography"
import { type EntryDraft, isSavingEntry, Message, type Model } from "./model"
import { describedByOf, stateOf } from "./view-field"
import type { Inputs } from "./view-parts"

// One catalog entry opened: its fields, and for admins the note, time field and field notes.

type H = HtmlBuilder<Message>

const entryIds = (entry: string, name: string) => ({
	control: `catalog-${entry}-${name}`,
	label: `catalog-${entry}-${name}-label`,
	error: `catalog-${entry}-${name}-error`,
	description: `catalog-${entry}-${name}-description`,
})

/** Enum-like sample values, e.g. "paid, refunded, failed"; empty for PII the audience cannot read. */
export const sampleLine = (catalogField: V2CatalogField): string | null =>
	catalogField.sample_values.length === 0 ? null : Arr.join(catalogField.sample_values, ", ")

const fieldRow = (
	h: H,
	entry: V2CatalogEntry,
	catalogField: V2CatalogField,
	draft: EntryDraft,
	canManage: boolean,
	isSaving: boolean,
): Html => {
	const note = draft.fieldNotes[catalogField.name] ?? ""
	const fieldIds = entryIds(entry.name, `field-${catalogField.name}`)
	const samples = sampleLine(catalogField)
	return hstack(h, { gap: "3", wrap: true, justify: "between", align: "start", className: "py-2" }, [
		vstack(h, { gap: "1", align: "start", className: "min-w-0 flex-1" }, [
			hstack(h, { gap: "2", wrap: true, className: "min-w-0" }, [
				typography(h, { mono: true, size: "xs", className: "break-all" }, [catalogField.name]),
				typography(h, { mono: true, size: "xs", tone: "muted" }, [
					catalogField.native_type ?? catalogField.type,
				]),
				...(catalogField.pii ? [badge(h, { variant: "meta", size: "sm" }, ["Personal data"])] : []),
			]),
			...(samples === null
				? []
				: [
						typography(h, { mono: true, size: "xs", tone: "muted", className: "break-words" }, [
							`e.g. ${samples}`,
						]),
					]),
		]),
		canManage
			? textarea(h, {
					id: fieldIds.control,
					size: "sm",
					className: "w-full sm:w-72",
					isDisabled: isSaving,
					attributes: [
						h.Value(note),
						h.Rows(1),
						h.Placeholder("Note for assistants"),
						h.AriaLabel(`Note for ${catalogField.name}`),
						h.OnInput((value) => Message.ChangedFieldNote({ field: catalogField.name, value })),
					],
				})
			: typography(h, { size: "xs", tone: "muted", className: "break-words sm:max-w-72" }, [
					catalogField.note ?? "",
				]),
	])
}

// The picker's values; a field is prefixed so no field name collides with the two choices.
const DETECTED = "detected"
const NONE = "none"
const FIELD_PREFIX = "field:"

const choiceValue = (timeField: string | null): string => {
	if (timeField === null) return DETECTED
	return timeField === "" ? NONE : `${FIELD_PREFIX}${timeField}`
}

/** The draft's time field for a picker value: detected is `null`, none is `""`. */
export const timeFieldOfChoice = (value: string): string | null => {
	if (value === DETECTED) return null
	return Str.startsWith(FIELD_PREFIX)(value) ? Str.slice(FIELD_PREFIX.length)(value) : ""
}

// Locked while a save is in flight: an edit made then would not be in the request, and would be lost.
const curation = (h: H, entry: V2CatalogEntry, draft: EntryDraft, isSaving: boolean): ReadonlyArray<Html> => {
	const noteIds = entryIds(entry.name, "note")
	const timeIds = entryIds(entry.name, "time")
	const timestamps = Arr.filter(entry.fields, (catalogField) => catalogField.type === "timestamp")
	return [
		field(h, { state: stateOf(draft.note, undefined) }, [
			fieldLabel(h, { ids: noteIds, state: stateOf(draft.note, undefined) }, "Note"),
			textarea(h, {
				id: noteIds.control,
				size: "sm",
				isDisabled: isSaving,
				attributes: [
					h.Value(draft.note),
					h.AriaLabelledBy(noteIds.label),
					h.Placeholder("Amounts are in cents; one row per payment attempt"),
					h.OnInput((value) => Message.ChangedEntryNote({ value })),
				],
			}),
		]),
		field(h, { state: stateOf(choiceValue(draft.timeField), undefined) }, [
			fieldLabel(
				h,
				{ ids: timeIds, state: stateOf(choiceValue(draft.timeField), undefined) },
				"Time field",
			),
			nativeSelect(
				h,
				{
					defaultValue: choiceValue(draft.timeField),
					isDisabled: isSaving,
					attributes: [
						h.Id(timeIds.control),
						h.AriaLabelledBy(timeIds.label),
						h.AriaDescribedBy(describedByOf(timeIds, false)),
						h.OnChange((value) =>
							Message.ChangedEntryTimeField({ value: timeFieldOfChoice(value) }),
						),
					],
				},
				[
					nativeOption(
						DETECTED,
						entry.detected_time_field === null
							? "Detected (the source reports none)"
							: `Detected (${entry.detected_time_field})`,
					),
					nativeOption(NONE, "None"),
					...Arr.map(timestamps, (catalogField) =>
						nativeOption(`${FIELD_PREFIX}${catalogField.name}`, catalogField.name),
					),
				],
			),
			fieldDescription(
				h,
				{ ids: timeIds, state: stateOf(choiceValue(draft.timeField), undefined) },
				"Dashboards and alerts filter this field to their time range.",
			),
		]),
	]
}

export const entryEditor = (
	h: H,
	model: Model,
	entry: V2CatalogEntry,
	draft: EntryDraft,
	inputs: Inputs,
): Html => {
	const isSaving = isSavingEntry(model, entry.name)
	return vstack(h, { gap: "3", className: "bg-surface-sunken rounded-md p-3" }, [
		...(inputs.canManage ? curation(h, entry, draft, isSaving) : []),
		vstack(h, { gap: "1" }, [
			typography(h, { size: "xs", weight: "medium" }, ["Fields"]),
			dividedList(
				h,
				{ as: "div" },
				Arr.map(entry.fields, (catalogField) =>
					fieldRow(h, entry, catalogField, draft, inputs.canManage, isSaving),
				),
			),
		]),
		...(inputs.canManage && model.entryError !== null
			? [
					alert(h, { variant: "crit", role: "status" }, [
						icon(h, "CircleWarningIcon"),
						alertTitle(h, ["Could not save the notes"]),
						alertDescription(h, [model.entryError.message]),
					]),
				]
			: []),
		...(inputs.canManage
			? [
					hstack(h, { gap: "2", justify: "end" }, [
						button(
							h,
							{
								variant: "ghost",
								size: "sm",
								isDisabled: isSaving,
								attributes: [h.OnClick(Message.ClickedCancelEntry())],
							},
							["Cancel"],
						),
						button(
							h,
							{
								size: "sm",
								isLoading: isSaving,
								attributes: [h.OnClick(Message.ClickedSaveEntry())],
							},
							["Save notes"],
						),
					]),
				]
			: []),
	])
}
