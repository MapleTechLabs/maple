import type { AlertRuleId } from "@maple/domain/http"
import { Option, Array as Arr } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import * as Checkbox from "@maple/views/ui/checkbox"
import * as ComboboxView from "@maple/views/ui/combobox-view"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { fieldErrorText } from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import { label } from "@maple/views/ui/label"
import { panel } from "@maple/views/ui/panel"
import { multiSegmentedSelect, segmentedSelect } from "@maple/views/ui/segmented-select"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { pickList } from "../../kit/pick-list"
import { dialogTextField, type DialogTextFieldOptions, matcherFields } from "../shared/matcher-fields"
import { formatDurationMinutes, WEEKDAYS } from "../shared/maintenance-windows"
import {
	daysError,
	durationError,
	durationOf,
	endsAtError,
	isScheduleChanged,
	matchersError,
	Message,
	type Model,
	nameError,
	reasonError,
	type ScheduleKind,
	startsAtError,
	startTimeError,
	zoneError,
	zoneItems,
} from "./dialog"

type H = HtmlBuilder<Message>

export type ViewInputs = Readonly<{
	id: string
	/** The org's rules, to pick from and to name the picked ones; `null` until they sync. */
	rules: ReadonlyArray<{ readonly id: string; readonly name: string }> | null
}>

const ID_PREFIX = "maintenance"

const KINDS: ReadonlyArray<{ value: ScheduleKind; label: string }> = [
	{ value: "weekly", label: "Weekly" },
	{ value: "once", label: "Once" },
]

/** An error once a save was tried. */
const shown = (model: Model, error: Option.Option<string>): Option.Option<string> =>
	model.isShowingErrors ? error : Option.none()

const textField = (h: H, model: Model, options: Omit<DialogTextFieldOptions<Message>, "idPrefix">): Html =>
	dialogTextField(h, { ...options, idPrefix: ID_PREFIX, isDisabled: model.isSaving })

/** An error that belongs to a group of controls rather than one input. */
const groupError = (h: H, id: string, error: Option.Option<string>): ReadonlyArray<Html> =>
	Option.toArray(
		Option.map(error, (message) =>
			fieldErrorText(h, { attributes: [h.Id(id), h.Role("alert")] }, message),
		),
	)

const ruleName = (inputs: ViewInputs, id: AlertRuleId): string =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(inputs.rules ?? [], (rule) => rule.id === id),
			(rule) => rule.name,
		),
		() => (inputs.rules === null ? "Rule" : "Deleted rule"),
	)

const rulesField = (h: H, model: Model, inputs: ViewInputs): Html =>
	vstack(h, { gap: "1.5" }, [
		typography(h, { size: "xs", weight: "medium" }, ["Rules"]),
		pickList(h, {
			entries: Arr.map(model.ruleIds, (id) => ({
				key: id,
				label: ruleName(inputs, id),
				media: icon(h, "BellIcon", { className: "text-muted-foreground" }),
				removeLabel: `Remove ${ruleName(inputs, id)}`,
				onRemove: Message.ClickedRemoveRule({ ruleId: id }),
			})),
			emptyText: "Any rule the fields below match",
			menu: model.ruleMenu,
			toMenuMessage: (message) => Message.GotRuleMenuMessage({ message }),
			addEntries: Arr.map(
				Arr.filter(inputs.rules ?? [], (rule) => !Arr.some(model.ruleIds, (id) => id === rule.id)),
				(rule) => ({ _tag: "Item" as const, value: rule.id, label: rule.name }),
			),
			addLabel: "Add rule",
			isDisabled: model.isSaving,
		}),
	])

const coversSection = (h: H, model: Model, inputs: ViewInputs): Html =>
	vstack(h, { gap: "2" }, [
		eyebrow(h, { variant: "label", as: "div" }, ["Covers"]),
		panel(h, { padded: true, className: "gap-3" }, [
			rulesField(h, model, inputs),
			...matcherFields(h, {
				idPrefix: ID_PREFIX,
				typed: model.typed,
				onInput: (field, value) => Message.ChangedMatcher({ field, value }),
				isDisabled: model.isSaving,
			}),
			...groupError(h, `${ID_PREFIX}-matchers-error`, shown(model, matchersError(model))),
		]),
	])

const weeklyFields = (h: H, model: Model): ReadonlyArray<Html> => [
	vstack(h, { gap: "1.5" }, [
		typography(h, { size: "xs", weight: "medium" }, ["Days"]),
		multiSegmentedSelect(h, {
			ariaLabel: "Days",
			options: Arr.map(WEEKDAYS, (day) => ({
				value: day.value,
				label: day.label,
				ariaLabel: day.label,
			})),
			value: model.days,
			onToggle: (day) => Message.ToggledDay({ day }),
			size: "sm",
			isDisabled: model.isSaving,
			className: "max-w-full flex-wrap",
		}),
		...groupError(h, `${ID_PREFIX}-days-error`, shown(model, daysError(model.days))),
	]),
	hstack(h, { gap: "3", align: "start", className: "*:flex-1" }, [
		textField(h, model, {
			name: "start-time",
			label: "Starts at",
			value: model.startTime,
			placeholder: "02:00",
			type: "time",
			onInput: (value) => Message.ChangedStartTime({ value }),
			error: shown(model, startTimeError(model.startTime)),
		}),
		textField(h, model, {
			name: "duration",
			label: "Duration (minutes)",
			value: model.durationMinutes,
			placeholder: "120",
			onInput: (value) => Message.ChangedDuration({ value }),
			description: Option.match(
				Option.filter(durationOf(model.durationMinutes), (n) => n > 0),
				{
					onNone: () => "5 minutes to 7 days",
					onSome: (minutes) => `${formatDurationMinutes(minutes)} each time`,
				},
			),
			error: shown(model, durationError(model.durationMinutes)),
		}),
	]),
]

const onceFields = (h: H, model: Model): ReadonlyArray<Html> => [
	hstack(h, { gap: "3", align: "start", wrap: true, className: "*:min-w-48 *:flex-1" }, [
		textField(h, model, {
			name: "starts-at",
			label: "Starts",
			value: model.startsAt,
			placeholder: "",
			type: "datetime-local",
			onInput: (value) => Message.ChangedStartsAt({ value }),
			error: shown(model, startsAtError(model)),
		}),
		textField(h, model, {
			name: "ends-at",
			label: "Ends",
			value: model.endsAt,
			placeholder: "",
			type: "datetime-local",
			onInput: (value) => Message.ChangedEndsAt({ value }),
			// A wrong order shows as soon as both are typed; a missing one waits for a save.
			error: model.isShowingErrors
				? endsAtError(model, isScheduleChanged(model))
				: Option.filter(
						endsAtError(model, isScheduleChanged(model)),
						() => model.startsAt !== "" && model.endsAt !== "",
					),
		}),
	]),
]

const zoneField = (h: H, model: Model): Html =>
	vstack(h, { gap: "1.5" }, [
		label(h, { className: "text-xs", attributes: [h.For(`${model.zonePicker.id}-input`)] }, [
			"Time zone",
		]),
		h.submodel({
			slotId: model.zonePicker.id,
			model: model.zonePicker,
			view: ComboboxView.view,
			toParentMessage: (message) => Message.GotZoneMessage({ message }),
			viewInputs: {
				items: zoneItems(model),
				ariaLabel: "Time zone",
				placeholder: "Search time zones…",
				emptyText: "No time zone matches that",
				startAddon: icon(h, "GlobeIcon"),
				className: "w-full",
				highlightsSelected: true,
				toView: ({ field, rest }) => h.div([h.Class("contents")], [field, ...rest]),
			},
		}),
		...groupError(h, `${ID_PREFIX}-zone-error`, shown(model, zoneError(model.timeZone))),
	])

const scheduleSection = (h: H, model: Model): Html =>
	vstack(h, { gap: "2" }, [
		eyebrow(h, { variant: "label", as: "div" }, ["Schedule"]),
		panel(h, { padded: true, className: "gap-3" }, [
			segmentedSelect(h, {
				ariaLabel: "Repeats",
				options: KINDS,
				value: model.kind,
				onChange: (kind) => Message.ChangedKind({ kind }),
				size: "sm",
			}),
			...(model.kind === "weekly" ? weeklyFields(h, model) : onceFields(h, model)),
			zoneField(h, model),
		]),
	])

/** A checkbox with its label, and a muted line under it. */
const checkboxOption = (
	h: H,
	model: Model,
	options: Readonly<{ name: string; label: string; hint: string; isChecked: boolean; onToggle: Message }>,
): Html => {
	const inputId = `${ID_PREFIX}-${options.name}`
	return vstack(h, { gap: "1" }, [
		label(h, { className: "text-sm font-normal", attributes: [h.Id(Checkbox.labelId(inputId))] }, [
			...Checkbox.view(h, {
				model: { isChecked: options.isChecked },
				toParentMessage: () => options.onToggle,
				id: `${inputId}-root`,
				inputId,
				isDisabled: model.isSaving,
			}),
			options.label,
		]),
		typography(h, { size: "xs", tone: "muted", as: "p", className: "pl-6" }, [options.hint]),
	])
}

const optionsSection = (h: H, model: Model): Html =>
	vstack(h, { gap: "3" }, [
		checkboxOption(h, model, {
			name: "exclude-baselines",
			label: "Exclude from anomaly baselines",
			hint: "Only applies when the window names a service or an environment.",
			isChecked: model.excludeFromBaselines,
			onToggle: Message.ToggledExcludeFromBaselines(),
		}),
		checkboxOption(h, model, {
			name: "enabled",
			label: "Enabled",
			hint: "A disabled window silences nothing until you turn it back on.",
			isChecked: model.enabled,
			onToggle: Message.ToggledEnabled(),
		}),
	])

/** The maintenance window dialog: name, what it covers, when it runs, and its options. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const isEditing = model.editing !== null
	return formDialog(h, {
		slotId: `${inputs.id}-dialog`,
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		className: "sm:max-w-xl",
		title: isEditing ? "Edit maintenance window" : "New maintenance window",
		description:
			"Each occurrence silences the rules it covers. Rules keep checking and incidents still open, but no one is paged.",
		panelClassName: "space-y-5",
		fields: [
			textField(h, model, {
				name: "name",
				label: "Name",
				value: model.name,
				placeholder: "Weekend database maintenance",
				onInput: (value) => Message.ChangedName({ value }),
				error: shown(model, nameError(model.name)),
			}),
			coversSection(h, model, inputs),
			scheduleSection(h, model),
			textField(h, model, {
				name: "reason",
				label: "Reason (optional)",
				value: model.reason,
				placeholder: "Vacuum and index rebuilds",
				onInput: (value) => Message.ChangedReason({ value }),
				error: shown(model, reasonError(model.reason)),
			}),
			optionsSection(h, model),
			...(model.saveError === null
				? []
				: [
						alert(h, { variant: "crit", size: "sm" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, [isEditing ? "Couldn't save window" : "Couldn't create window"]),
							alertDescription(h, [model.saveError]),
						]),
					]),
		],
		onSubmit: Message.ClickedSave(),
		submitLabel: isEditing ? "Save window" : "Create window",
		isPending: model.isSaving,
	})
})
