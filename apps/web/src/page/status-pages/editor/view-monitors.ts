import type { V2StatusPageComponent } from "@maple/domain/http/v2"
import { Array as Arr, Option, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import * as Checkbox from "@maple/views/ui/checkbox"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { label } from "@maple/views/ui/label"
import { pressable } from "@maple/views/ui/pressable"
import { grid } from "@maple/views/ui/grid"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { type TypographyTone, typography } from "@maple/views/ui/typography"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { expandChevron } from "../../kit/expand-chevron"
import { adminOnlyNote, settingsSection } from "../../kit/settings-section"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_OPTIONS,
	COMPONENT_STATUS_TONE,
	componentStatus,
	statusReason,
} from "../shared/derive"
import { selectField, textField } from "../shared/fields"
import { RevealOpenComponent } from "./command"
import { Message } from "./message"
import { canManage, type ComponentSave, type Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf } from "./reads"
import { componentRowId, groupedOrder, moved } from "./update-components"
import { failureAlert } from "./view-panel"

// Settings > Monitors: the page's components by group, each opening in place with its fields; the
// page preview beside Settings shows how it reads.

type H = HtmlBuilder<Message>

const LABEL_TONE = {
	ok: "muted",
	info: "muted",
	warn: "warning",
	crit: "error",
} as const satisfies Partial<Record<Tone, TypographyTone>>

const SAVE_LABEL = { Saving: "Saving", Saved: "Saved", Failed: "Not saved" } as const satisfies Record<
	ComponentSave["_tag"],
	string
>

/** The last save, when it was this component's. */
const saveOf = (model: Model, component: V2StatusPageComponent): ComponentSave | null =>
	model.componentSave?.componentId === component.id ? model.componentSave : null

const saveIndicator = (h: H, save: ComponentSave | null): Html =>
	typography(
		h,
		{
			size: "xs",
			mono: true,
			tone: save?._tag === "Failed" ? "destructive" : "muted",
			attributes: [h.AriaLive("polite")],
		},
		[save === null ? "" : SAVE_LABEL[save._tag]],
	)

/** The page's other groups as one-click picks, so a group is never retyped (or mistyped). */
const groupSuggestions = (h: H, model: Model, isReadOnly: boolean): ReadonlyArray<Html> => {
	const current = Str.trim(model.componentForm.group)
	const groups = Arr.filter(
		Arr.dedupe(Arr.flatMap(componentsOf(model), (row) => (row.group === null ? [] : [row.group]))),
		(group) => group !== current,
	)
	return isReadOnly || groups.length === 0
		? []
		: [
				hstack(
					h,
					{
						gap: "1.5",
						wrap: true,
						className: "sm:col-span-2",
						attributes: [h.Role("group"), h.AriaLabel("Groups on this page")],
					},
					Arr.map(groups, (group) =>
						button(
							h,
							{
								size: "xs",
								variant: "outline",
								attributes: [
									h.Key(group),
									h.OnClick(Message.PickedComponentField({ field: "group", value: group })),
								],
							},
							[group],
						),
					),
				),
			]
}

/** The open component's fields, why it shows what it shows. The page preview beside Settings shows its row. */
const componentForm = (h: H, model: Model, component: V2StatusPageComponent): Html => {
	const form = model.componentForm
	const isReadOnly = !canManage(model)
	const hasMonitor = form.monitorId !== ""
	const uptimeId = "status-page-panel-uptime"
	const reason = statusReason(component, monitorsOf(model), incidentsOf(model))
	const save = saveOf(model, component)
	return vstack(
		h,
		{
			gap: "4",
			className: "px-4 pt-1 pb-4 sm:pl-12",
			attributes: model.revealComponentId === component.id ? [h.OnMount(RevealOpenComponent())] : [],
		},
		[
			...(isReadOnly
				? [adminOnlyNote(h, ["Only org admins and engineers can change components."])]
				: []),
			grid(h, { sm: 2, gap: "4" }, [
				textField(h, {
					id: "status-page-panel-name",
					label: "Shown as",
					value: form.name,
					isDisabled: isReadOnly,
					error: Str.trim(form.name) === "" ? "Add a name." : null,
					onInput: (value) => Message.ChangedComponentField({ field: "name", value }),
					onBlur: Message.CommittedComponent(),
				}),
				textField(h, {
					id: "status-page-panel-group",
					label: "Group",
					value: form.group,
					placeholder: "None",
					hint: "Components with one group are listed under it.",
					isDisabled: isReadOnly,
					onInput: (value) => Message.ChangedComponentField({ field: "group", value }),
					onBlur: Message.CommittedComponent(),
				}),
				...groupSuggestions(h, model, isReadOnly),
				textField(h, {
					id: "status-page-panel-description",
					label: "Description",
					value: form.description,
					placeholder: "None",
					hint: "A line under the name, for what this covers.",
					isDisabled: isReadOnly,
					className: "sm:col-span-2",
					onInput: (value) => Message.ChangedComponentField({ field: "description", value }),
					onBlur: Message.CommittedComponent(),
				}),
				selectField(h, {
					id: "status-page-panel-monitor",
					label: "Driven by",
					value: form.monitorId,
					isDisabled: isReadOnly,
					entries: [
						{ value: "", label: "No monitor" },
						...Arr.map(monitorsOf(model), (monitor) => ({
							value: monitor.id,
							label: monitor.name,
						})),
					],
					onInput: (value) => Message.PickedComponentField({ field: "monitorId", value }),
				}),
				selectField(h, {
					id: "status-page-panel-status",
					label: "Override status",
					value: form.manualStatus,
					isDisabled: isReadOnly,
					hint: hasMonitor
						? "Automatic follows the monitor and open incidents."
						: "Automatic follows open incidents.",
					entries: [
						{ value: "", label: "Automatic" },
						...Arr.map(COMPONENT_STATUS_OPTIONS, (value) => ({
							value,
							label: COMPONENT_STATUS_LABEL[value],
						})),
					],
					onInput: (value) => Message.PickedComponentField({ field: "manualStatus", value }),
				}),
			]),
			...(reason === null
				? []
				: [
						alert(h, { variant: "warn", size: "sm" }, [
							icon(h, "AlertWarningIcon"),
							alertDescription(h, [reason]),
						]),
					]),
			vstack(h, { gap: "1" }, [
				label(
					h,
					{
						className: "flex font-normal text-sm sm:text-sm",
						attributes: [h.Id(Checkbox.labelId(uptimeId))],
					},
					[
						...Checkbox.view(h, {
							// The stored value, shown as is; it only takes effect once a monitor drives the component.
							model: { isChecked: form.showUptime },
							toParentMessage: () => Message.ToggledComponentUptime(),
							id: `${uptimeId}-root`,
							inputId: uptimeId,
							isDisabled: isReadOnly || !hasMonitor,
						}),
						h.span([], ["Show uptime bars"]),
					],
				),
				...(hasMonitor
					? []
					: [
							typography(h, { size: "xs", tone: "muted", as: "p" }, [
								"Uptime bars need a monitor.",
							]),
						]),
			]),
			...failureAlert(h, "Couldn't save the component", save?._tag === "Failed" ? save.failure : null),
			hstack(h, { gap: "3", justify: "between", wrap: true }, [
				isReadOnly
					? h.span([], [])
					: button(
							h,
							{
								size: "sm",
								variant: "destructive-outline",
								attributes: [
									h.OnClick(Message.ClickedDeleteComponent({ componentId: component.id })),
								],
							},
							["Remove from page"],
						),
				saveIndicator(h, save),
			]),
		],
	)
}

const moveButtons = (h: H, model: Model, component: V2StatusPageComponent): Html => {
	const rows = componentsOf(model)
	const move = (offset: number, glyph: "ChevronUpIcon" | "ChevronDownIcon", word: string) =>
		iconButton(
			h,
			{
				label: `Move ${component.name} ${word}`,
				size: "icon-2xs",
				isDisabled: model.isReordering || moved(rows, component.id, offset) === null,
				attributes: [h.OnClick(Message.ClickedMoveComponent({ componentId: component.id, offset }))],
			},
			[icon(h, glyph)],
		)
	return vstack(h, { className: "shrink-0" }, [
		move(-1, "ChevronUpIcon", "up"),
		move(1, "ChevronDownIcon", "down"),
	])
}

/** What drives the component: its monitor by name, or incidents alone. */
const sourceLine = (model: Model, component: V2StatusPageComponent): string =>
	component.monitor_id === null
		? "No monitor. Follows incidents only"
		: Option.match(
				Arr.findFirst(monitorsOf(model), (monitor) => monitor.id === component.monitor_id),
				{ onNone: () => "Monitor not found", onSome: (monitor) => `Monitor: ${monitor.name}` },
			)

const componentRow = (h: H, model: Model, component: V2StatusPageComponent): Html => {
	const status = componentStatus(component, monitorsOf(model), incidentsOf(model))
	const isOpen = model.panel?._tag === "Component" && model.panel.componentId === component.id
	return h.li(
		[h.Key(component.id), h.Class("border-t first:border-t-0")],
		[
			hstack(h, { gap: "1", className: "pl-2" }, [
				...(canManage(model) ? [moveButtons(h, model, component)] : []),
				pressable(
					h,
					{
						onClick: Message.ClickedComponent({ componentId: component.id }),
						className: cn(
							"flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left hover:bg-surface-sunken active:bg-surface-sunken",
							isOpen && "bg-surface-sunken",
						),
						attributes: [h.Id(componentRowId(component.id)), h.AriaExpanded(isOpen)],
					},
					[
						statusDot(h, { tone: COMPONENT_STATUS_TONE[status], size: "lg" }),
						typography(
							h,
							{ size: "sm", weight: "medium", truncate: true, className: "shrink-0" },
							[component.name],
						),
						typography(h, { size: "xs", tone: "muted", mono: true, truncate: true }, [
							sourceLine(model, component),
						]),
						typography(
							h,
							{
								size: "xs",
								tone: LABEL_TONE[COMPONENT_STATUS_TONE[status]],
								className: "ml-auto shrink-0",
							},
							[COMPONENT_STATUS_LABEL[status]],
						),
						expandChevron(h, isOpen),
					],
				),
			]),
			...(isOpen ? [componentForm(h, model, component)] : []),
		],
	)
}

/** The components under each group's head, in page order, ungrouped last. */
const componentList = (h: H, model: Model): Html => {
	const rows = groupedOrder(componentsOf(model))
	const groups = Arr.dedupe(Arr.map(rows, (row) => row.group))
	const hasGroups = Arr.some(groups, (group) => group !== null)
	return vstack(
		h,
		{ attributes: [h.AriaLabel("Components")] },
		Arr.map(groups, (group) =>
			vstack(h, { attributes: [h.Key(group ?? "")] }, [
				...(hasGroups
					? [
							h.div(
								[h.Class("bg-surface-sunken px-4 py-2")],
								[eyebrow(h, {}, [group ?? "No group"])],
							),
						]
					: []),
				h.ul(
					[h.AriaLabel(group ?? "No group")],
					Arr.map(
						Arr.filter(rows, (row) => row.group === group),
						(component) => componentRow(h, model, component),
					),
				),
			]),
		),
	)
}

export const monitorsSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "status-page-settings-monitors",
			title: "Monitors",
			description: ["Each one is a row under System status, in this order."],
			padded: false,
			actions: canManage(model)
				? button(
						h,
						{
							size: "sm",
							// Reopened mid-save, Add would list the monitors being added again.
							isLoading: model.isAddingComponents,
							attributes: [h.OnClick(Message.ClickedAddComponent())],
						},
						[icon(h, "PlusIcon"), "Add monitors"],
					)
				: undefined,
		},
		[
			componentsOf(model).length === 0
				? typography(h, { size: "sm", tone: "muted", as: "p", className: "p-4" }, [
						canManage(model)
							? "Nothing yet. Add a monitor and visitors see its status and uptime."
							: "No monitors on this page yet.",
					])
				: componentList(h, model),
		],
	)
