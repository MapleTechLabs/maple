import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "@maple/views/data/load-failure"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import * as ComboboxView from "@maple/views/ui/combobox-view"
import { errorState } from "@maple/views/ui/error-state"
import { fieldErrorText } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { input } from "@maple/views/ui/input"
import { label } from "@maple/views/ui/label"
import * as Menu from "@maple/views/ui/menu"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { panel } from "@maple/views/ui/panel"
import { personAvatar } from "@maple/views/ui/person-avatar"
import { multiSegmentedSelect, segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import { typography, typographyClass } from "@maple/views/ui/typography"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import {
	formActionBar,
	formCard,
	formScrollArea,
	formSection,
	managersOnlyPage,
} from "../../kit/form-section"
import { pickList } from "../../kit/pick-list"
import { oncallTabHref, scheduleHref } from "../shared/oncall-schedules"
import { memberName, memberOf } from "../shared/org-members"
import {
	descriptionError,
	formIssues,
	type LayerDraft,
	layerErrors,
	MAX_ONCALL_LAYERS,
	MAX_ONCALL_RESTRICTIONS,
	nameError,
	type RestrictionDraft,
	RotationKind,
	WEEKDAYS,
	zoneError,
} from "./form"
import { type LayerField, Message } from "./message"
import { canManage, type Model } from "./model"
import { participantMenuId } from "./update"

// `/alerts/schedules/new`: the schedule's name and zone, then its layers: who rotates, how they
// hand off, from when, and the weekly windows a layer is limited to.

type H = HtmlBuilder<Message>

const FORM_WIDTH = "max-w-3xl"

/** A field's error line once a save was tried. */
const shown = (h: H, model: Model, error: Option.Option<string>): ReadonlyArray<Html> =>
	model.isShowingErrors
		? Option.match(error, {
				onNone: () => [],
				onSome: (text) => [fieldErrorText(h, { attributes: [h.Role("alert")] }, text)],
			})
		: []

const fieldLabel = (h: H, id: string, text: string): Html =>
	label(h, { className: typographyClass({ size: "xs", tone: "muted" }), attributes: [h.For(id)] }, [text])

/** A labelled input bound to one value. */
const textInput = (
	h: H,
	options: Readonly<{
		id: string
		label: string
		value: string
		type?: string
		placeholder?: string
		className?: string
		/** The section's title already names it: the label is for screen readers. */
		isLabelHidden?: boolean
		onInput: (value: string) => Message
	}>,
): Html =>
	vstack(h, { gap: "1.5", className: options.className }, [
		options.isLabelHidden === true
			? label(h, { className: "sr-only", attributes: [h.For(options.id)] }, [options.label])
			: fieldLabel(h, options.id, options.label),
		input(h, {
			id: options.id,
			type: options.type,
			attributes: [
				h.Value(options.value),
				h.OnInput(options.onInput),
				h.Attribute("autocomplete", "off"),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
			],
		}),
	])

const nameSection = (h: H, model: Model): Html =>
	formSection(h, { title: "Name" }, [
		textInput(h, {
			id: "schedule-name",
			label: "Name",
			isLabelHidden: true,
			value: model.form.name,
			placeholder: "Checkout primary",
			onInput: (value) => Message.ChangedName({ value }),
		}),
		...shown(h, model, nameError(model.form.name)),
		vstack(h, { gap: "1.5" }, [
			fieldLabel(h, "schedule-description", "Description (optional)"),
			textarea(h, {
				id: "schedule-description",
				defaultValue: model.form.description,
				attributes: [
					h.Rows(2),
					h.Placeholder("Who is on this rotation and how to swap a shift"),
					h.OnInput((value) => Message.ChangedDescription({ value })),
				],
			}),
		]),
		...shown(h, model, descriptionError(model.form.description)),
	])

/** The schedule's zone: a searchable list of every IANA zone, the viewer's own first by default. */
const zoneSection = (h: H, model: Model): Html =>
	formSection(h, { title: "Time zone", hint: "Handoffs and restrictions read in it" }, [
		vstack(h, { gap: "1.5", className: "max-w-sm" }, [
			label(h, { className: "sr-only", attributes: [h.For(`${model.zonePicker.id}-input`)] }, [
				"Time zone",
			]),
			h.submodel({
				slotId: model.zonePicker.id,
				model: model.zonePicker,
				view: ComboboxView.view,
				toParentMessage: (message) => Message.GotZoneMessage({ message }),
				viewInputs: {
					items: model.zones,
					ariaLabel: "Time zone",
					placeholder: "Search time zones…",
					emptyText: "No time zone matches that",
					startAddon: icon(h, "GlobeIcon"),
					className: "w-full",
					highlightsSelected: true,
					toView: ({ field, rest }) => h.div([h.Class("contents")], [field, ...rest]),
				},
			}),
		]),
		...shown(h, model, zoneError(model.form.timeZone)),
	])

/** The rotation's people, in order, with an "Add person" menu of the rest. */
const participantsField = (h: H, model: Model, layer: LayerDraft, index: number): Html => {
	const key = layer.key
	const count = layer.participants.length
	const addEntries: ReadonlyArray<MenuEntry> = Arr.flatMap(model.members ?? [], (member) =>
		layer.participants.includes(member.userId)
			? []
			: [
					{
						_tag: "Item",
						value: member.userId,
						label: member.name,
						content: [
							hstack(h, { gap: "2", shrink: true, as: "span" }, [
								personAvatar(h, { name: member.name, imageUrl: member.imageUrl, size: "xs" }),
								typography(h, { truncate: true, className: "min-w-0 flex-1" }, [member.name]),
							]),
						],
					},
				],
	)
	return vstack(h, { gap: "1.5" }, [
		typography(h, { size: "xs", tone: "muted", as: "p" }, ["People, in rotation order"]),
		pickList(h, {
			entries: Arr.map(layer.participants, (userId, at) => {
				const name = memberName(model.members, userId)
				return {
					key: userId,
					label: name,
					media: personAvatar(h, {
						name,
						size: "xs",
						imageUrl: Option.getOrUndefined(
							Option.map(memberOf(model.members, userId), (member) => member.imageUrl),
						),
					}),
					removeLabel: `Remove ${name} from layer ${index + 1}`,
					onRemove: Message.ClickedRemoveParticipant({ key, userId }),
					move: {
						up:
							at === 0
								? null
								: Message.ClickedMoveParticipant({ key, userId, direction: "up" }),
						down:
							at === count - 1
								? null
								: Message.ClickedMoveParticipant({ key, userId, direction: "down" }),
					},
				}
			}),
			emptyText:
				model.membersError === null
					? "Nobody yet. Add who takes turns."
					: `Couldn't load members: ${model.membersError}`,
			menu: model.menus[key] ?? Menu.init(participantMenuId(key)),
			toMenuMessage: (message) => Message.GotParticipantMenuMessage({ key, message }),
			addEntries,
			addLabel: "Add person",
		}),
	])
}

const ROTATIONS: ReadonlyArray<Readonly<{ value: RotationKind; label: string }>> = [
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
	{ value: "custom", label: "Custom" },
]

const layerText = (key: string, field: LayerField) => (value: string) =>
	Message.ChangedLayerText({ key, field, value })

/** How the layer hands off: the kind, then its day and time or its shift length. */
const rotationField = (h: H, layer: LayerDraft): Html => {
	const key = layer.key
	return vstack(h, { gap: "2" }, [
		typography(h, { size: "xs", tone: "muted", as: "p" }, ["Hand off"]),
		segmentedSelect(h, {
			ariaLabel: "Rotation",
			size: "sm",
			className: "w-fit",
			value: layer.rotation,
			onChange: (rotation) => Message.PickedRotation({ key, rotation }),
			options: ROTATIONS,
		}),
		hstack(h, { gap: "3", wrap: true, align: "end" }, [
			...(layer.rotation === "weekly"
				? [
						vstack(h, { gap: "1.5" }, [
							fieldLabel(h, `${key}-weekday`, "Day"),
							nativeSelect(
								h,
								{
									defaultValue: layer.handoffWeekday,
									className: "w-32",
									attributes: [
										h.Key(`${key}-weekday`),
										h.Id(`${key}-weekday`),
										h.OnChange((value) =>
											Option.match(
												Arr.findFirst(WEEKDAYS, (day) => day.value === value),
												{
													onNone: () =>
														Message.PickedHandoffWeekday({
															key,
															weekday: layer.handoffWeekday,
														}),
													onSome: (day) =>
														Message.PickedHandoffWeekday({
															key,
															weekday: day.value,
														}),
												},
											),
										),
									],
								},
								Arr.map(WEEKDAYS, (day) => nativeOption(day.value, day.label)),
							),
						]),
					]
				: []),
			...(layer.rotation === "custom"
				? [
						textInput(h, {
							id: `${key}-length`,
							label: "Every, in hours",
							type: "number",
							value: layer.lengthHours,
							className: "w-32",
							onInput: layerText(key, "lengthHours"),
						}),
					]
				: [
						textInput(h, {
							id: `${key}-handoff`,
							label: "At",
							type: "time",
							value: layer.handoffTime,
							className: "w-32",
							onInput: layerText(key, "handoffTime"),
						}),
					]),
		]),
	])
}

/** One weekly window: its days, from and to (an end at or before the start crosses midnight). */
const restrictionRow = (h: H, layer: LayerDraft, restriction: RestrictionDraft): Html => {
	const key = layer.key
	const restrictionKey = restriction.key
	const crossesMidnight = restriction.endTime <= restriction.startTime
	return vstack(h, { gap: "2", className: "rounded-md border p-3", attributes: [h.Key(restrictionKey)] }, [
		hstack(h, { gap: "2", justify: "between", wrap: true }, [
			multiSegmentedSelect(h, {
				ariaLabel: "Days",
				size: "sm",
				className: "flex-wrap",
				value: restriction.weekdays,
				onToggle: (weekday) => Message.ToggledRestrictionDay({ key, restrictionKey, weekday }),
				options: Arr.map(WEEKDAYS, (day) => ({
					value: day.value,
					label: day.label,
					ariaLabel: day.label,
				})),
			}),
			iconButton(
				h,
				{
					label: "Remove this window",
					className: "text-muted-foreground",
					attributes: [h.OnClick(Message.ClickedRemoveRestriction({ key, restrictionKey }))],
				},
				[icon(h, "TrashIcon")],
			),
		]),
		hstack(h, { gap: "3", wrap: true, align: "end" }, [
			textInput(h, {
				id: `${restrictionKey}-start`,
				label: "From",
				type: "time",
				value: restriction.startTime,
				className: "w-32",
				onInput: (value) =>
					Message.ChangedRestrictionTime({ key, restrictionKey, edge: "start", value }),
			}),
			textInput(h, {
				id: `${restrictionKey}-end`,
				label: "To",
				type: "time",
				value: restriction.endTime,
				className: "w-32",
				onInput: (value) =>
					Message.ChangedRestrictionTime({ key, restrictionKey, edge: "end", value }),
			}),
			typography(h, { size: "xs", tone: "muted", className: "pb-2" }, [
				crossesMidnight ? "Ends the next morning" : "Same day",
			]),
		]),
	])
}

const restrictionsField = (h: H, model: Model, layer: LayerDraft): Html => {
	const errors = layerErrors(layer, model.form.timeZone).restrictions
	return vstack(h, { gap: "2" }, [
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			layer.restrictions.length === 0
				? "Always active. Limit it to weekly windows, like nights or weekends."
				: "Only active in these windows",
		]),
		...Arr.flatMap(layer.restrictions, (restriction, index) => [
			restrictionRow(h, layer, restriction),
			...shown(h, model, errors[index] ?? Option.none()),
		]),
		button(
			h,
			{
				variant: "outline",
				size: "sm",
				className: "self-start",
				isDisabled: layer.restrictions.length >= MAX_ONCALL_RESTRICTIONS,
				attributes: [h.OnClick(Message.ClickedAddRestriction({ key: layer.key }))],
			},
			[icon(h, "PlusIcon"), "Add window"],
		),
	])
}

/** One layer: its name and order, its people, how it hands off, from when, and its windows. */
const layerBlock = (h: H, model: Model, layer: LayerDraft, index: number): Html => {
	const key = layer.key
	const count = model.form.layers.length
	const errors = layerErrors(layer, model.form.timeZone)
	return panel(h, { padded: "sm", className: "gap-4", attributes: [h.Key(key)] }, [
		hstack(h, { gap: "2", justify: "between", align: "end" }, [
			textInput(h, {
				id: `${key}-name`,
				label: index === 0 ? `Layer ${index + 1}, at the bottom` : `Layer ${index + 1}`,
				value: layer.name,
				className: "min-w-0 max-w-xs flex-1",
				onInput: layerText(key, "name"),
			}),
			hstack(h, { gap: "0.5" }, [
				iconButton(
					h,
					{
						label: `Move layer ${index + 1} up`,
						isDisabled: index === 0,
						attributes: [h.OnClick(Message.ClickedMoveLayer({ key, direction: "up" }))],
					},
					[icon(h, "ArrowUpIcon")],
				),
				iconButton(
					h,
					{
						label: `Move layer ${index + 1} down`,
						isDisabled: index === count - 1,
						attributes: [h.OnClick(Message.ClickedMoveLayer({ key, direction: "down" }))],
					},
					[icon(h, "ArrowDownIcon")],
				),
				iconButton(
					h,
					{
						label: `Remove layer ${index + 1}`,
						isDisabled: count === 1,
						attributes: [h.OnClick(Message.ClickedRemoveLayer({ key }))],
					},
					[icon(h, "TrashIcon")],
				),
			]),
		]),
		...shown(h, model, errors.name),
		participantsField(h, model, layer, index),
		...shown(h, model, errors.participants),
		rotationField(h, layer),
		...shown(h, model, errors.handoff),
		textInput(h, {
			id: `${key}-starts`,
			label: `Starts, in ${model.form.timeZone}: the first person holds this shift`,
			type: "datetime-local",
			value: layer.startsAt,
			className: "max-w-sm",
			onInput: layerText(key, "startsAt"),
		}),
		...shown(h, model, errors.startsAt),
		restrictionsField(h, model, layer),
	])
}

const layersSection = (h: H, model: Model): Html =>
	formSection(h, { title: "Layers", hint: "Later layers sit on top where they have someone on call" }, [
		...Arr.map(model.form.layers, (layer, index) => layerBlock(h, model, layer, index)),
		...shown(
			h,
			model,
			model.form.layers.length === 0 ? Option.some("Add at least one layer") : Option.none(),
		),
		hstack(h, { gap: "3" }, [
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					isDisabled: model.form.layers.length >= MAX_ONCALL_LAYERS,
					attributes: [h.OnClick(Message.ClickedAddLayer())],
				},
				[icon(h, "PlusIcon"), "Add layer"],
			),
			typography(h, { size: "xs", tone: "muted", numeric: true }, [
				`${model.form.layers.length} of ${MAX_ONCALL_LAYERS}`,
			]),
		]),
	])

const backHref = (model: Model) =>
	model.editingId === null ? oncallTabHref() : scheduleHref(model.editingId)

const actionBar = (h: H, model: Model): Html => {
	const issues = formIssues(model.form)
	return formActionBar(h, {
		issues,
		widthClass: FORM_WIDTH,
		notice:
			model.saveFailure === null
				? null
				: alert(h, { variant: "crit", size: "sm", className: `mb-3 ${FORM_WIDTH}` }, [
						icon(h, "CircleXmarkIcon"),
						alertTitle(h, [
							model.editingId === null
								? "Couldn't create the schedule"
								: "Couldn't save the schedule",
						]),
						alertDescription(h, [failureMessage(model.saveFailure)]),
					]),
		actions: [
			linkButton(h, { variant: "outline", href: backHref(model) }, ["Cancel"]),
			button(
				h,
				{
					isDisabled: !canManage(model),
					isLoading: model.isSaving,
					attributes: [h.OnClick(Message.ClickedSave())],
				},
				[model.editingId === null ? "Create schedule" : "Save changes"],
			),
		],
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const isEdit = model.editingId !== null
	const header = {
		title: isEdit ? "Edit schedule" : "New schedule",
		description: "Who is on call when: people take turns in layers, in one time zone.",
	}
	if (model.isSessionLoaded && !canManage(model))
		return managersOnlyPage(h, {
			header,
			title: "Only org admins and engineers can create or change on-call schedules",
			back: { href: backHref(model), label: isEdit ? "Back to the schedule" : "Back to on-call" },
		})
	if (isEdit && AsyncData.isFailure(model.existing.data))
		return dashboardPage(h, header, [
			errorState(h, { failure: model.existing.data.error, title: "Couldn't load the schedule" }),
		])
	if (!model.isReady || (isEdit && !AsyncData.isSuccess(model.existing.data)))
		return dashboardPage(h, header, [skeleton(h, "h-24 w-full"), skeleton(h, "h-80 w-full")])
	return dashboardPage(h, { ...header, fill: true }, [
		formScrollArea(h, [
			formCard(h, [nameSection(h, model), zoneSection(h, model), layersSection(h, model)], FORM_WIDTH),
		]),
		actionBar(h, model),
	])
})
