import type { StatusPageComponentStatus } from "@maple/domain"
import type { V2UptimeMonitor } from "@maple/domain/http/v2"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { button } from "@maple/views/ui/button"
import { dragGrip } from "@maple/views/ui/drag-grip"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { grid } from "@maple/views/ui/grid"
import { label } from "@maple/views/ui/label"
import { pressable } from "@maple/views/ui/pressable"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { switchControl } from "@maple/views/ui/switch"
import { type TypographyTone, typography } from "@maple/views/ui/typography"
import { Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { expandChevron } from "../../kit/expand-chevron"
import { gatedControl, type Grants } from "../../kit/session-grants"
import { GRIP_ATTRIBUTE, LIST_ATTRIBUTE, ROW_ATTRIBUTE, SLOT_ATTRIBUTE } from "./component-drag"
import { COMPONENT_STATUS_LABEL, COMPONENT_STATUS_OPTIONS, COMPONENT_STATUS_TONE } from "./derive"
import type { ComponentForm, ComponentTextField } from "./form"
import { buttonField, selectField, textField } from "./fields"

// A page's components as one list, the same in the builder and under Settings > Monitors: rows by
// group, each opening in place with its fields, reordered by its grip within its group.

/** The status label's tone: only a warning or an outage is coloured. */
export const LABEL_TONE = {
	ok: "muted",
	info: "muted",
	warn: "warning",
	crit: "error",
} as const satisfies Partial<Record<Tone, TypographyTone>>

export type ComponentRow<M> = Readonly<{
	/** The drag's key: the component's id, or the builder's row key. */
	key: string
	name: string
	group: string | null
	status: StatusPageComponentStatus
	/** What drives it: "Monitor: API", "No monitor. Follows incidents only". */
	source: string
	isOpen: boolean
	rowId: string
	gripId: string
	onToggle: M
	onMove: (offset: -1 | 1) => M
	/** The open row's fields, under its head. */
	body: ReadonlyArray<Html>
}>

export type ComponentListOptions<M> = Readonly<{
	/** In page order with each group's members together, as `groupedOrder` lists them. */
	rows: ReadonlyArray<ComponentRow<M>>
	grants: Grants
	/** An order save is in flight: the grips stay focusable but do nothing. */
	isReorderBusy?: boolean
	/** The sr-only hint the grips point at; unique per page. */
	hintId: string
	/** Above the groups: an alert for a refused order save. */
	leading?: ReadonlyArray<Html>
}>

/**
 * The row's handle: dragged, or moved a slot with the arrow keys, within its group. Locked, it
 * drops its drag marker, so the drag subscription never picks it up.
 */
const grip = <M>(h: HtmlBuilder<M>, options: ComponentListOptions<M>, row: ComponentRow<M>): Html =>
	gatedControl(
		h,
		options.grants,
		"status_pages:edit",
		(isDisabled) =>
			dragGrip(h, {
				label: `Reorder ${row.name}`,
				onMove: row.onMove,
				className: "self-stretch px-1",
				attributes: isDisabled
					? [h.Disabled(true)]
					: [
							h.Id(row.gripId),
							h.DataAttribute(GRIP_ATTRIBUTE, ""),
							h.AriaDescribedBy(options.hintId),
							// Still focusable while the order saves, so the keyboard keeps its place.
							h.AriaDisabled(options.isReorderBusy === true),
						],
			}),
		{ className: "self-stretch" },
	)

const rowView = <M>(h: HtmlBuilder<M>, options: ComponentListOptions<M>, row: ComponentRow<M>): Html => {
	const tone = COMPONENT_STATUS_TONE[row.status]
	return h.li(
		[
			h.Key(row.key),
			h.DataAttribute(ROW_ATTRIBUTE, row.key),
			h.Class(
				"border-t first:border-t-0 data-dragging:relative data-dragging:z-10 data-dragging:rounded-md data-dragging:bg-card data-dragging:shadow-popup data-dragging:outline data-dragging:outline-primary-a4",
			),
		],
		[
			hstack(h, { gap: "1", className: "pl-2" }, [
				grip(h, options, row),
				pressable(
					h,
					{
						onClick: row.onToggle,
						className: cn(
							"flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left hover:bg-surface-sunken active:bg-surface-sunken",
							row.isOpen && "bg-surface-sunken",
						),
						attributes: [h.Id(row.rowId), h.AriaExpanded(row.isOpen)],
					},
					[
						statusDot(h, { tone, size: "lg" }),
						typography(
							h,
							{ size: "sm", weight: "medium", truncate: true, className: "shrink-0" },
							[row.name],
						),
						typography(h, { size: "xs", tone: "muted", mono: true, truncate: true }, [
							row.source,
						]),
						typography(h, { size: "xs", tone: LABEL_TONE[tone], className: "ml-auto shrink-0" }, [
							COMPONENT_STATUS_LABEL[row.status],
						]),
						expandChevron(h, row.isOpen),
					],
				),
			]),
			// Level with the row's status dot, past the grip.
			...(row.isOpen ? [vstack(h, { gap: "4", className: "pt-1 pr-4 pb-4 pl-10.5" }, row.body)] : []),
		],
	)
}

/** The components under each group's head, ungrouped ones under "No group" once any is grouped. */
export const componentList = <M>(h: HtmlBuilder<M>, options: ComponentListOptions<M>): Html => {
	const groups = Arr.dedupe(Arr.map(options.rows, (row) => row.group))
	const hasGroups = Arr.some(groups, (group) => group !== null)
	return vstack(h, { attributes: [h.AriaLabel("Components")] }, [
		h.span(
			[h.Id(options.hintId), h.Class("sr-only")],
			["Drag, or press the up and down arrow keys, to move it within its group."],
		),
		...(options.leading ?? []),
		...Arr.map(groups, (group) =>
			vstack(h, { attributes: [h.Key(group ?? "")] }, [
				...(hasGroups
					? [
							h.div(
								[h.Class("bg-surface-sunken px-4 py-2")],
								[eyebrow(h, {}, [group ?? "No group"])],
							),
						]
					: []),
				// The slot outline sits under the rows, as wide as they are; a drag moves it to where
				// the held row lands.
				h.div(
					[h.DataAttribute(LIST_ATTRIBUTE, ""), h.Class("relative")],
					[
						h.div(
							[
								h.DataAttribute(SLOT_ATTRIBUTE, ""),
								h.AriaHidden(true),
								h.Class(
									"pointer-events-none invisible absolute inset-x-0 top-0 rounded-md border border-dashed border-primary-a4 bg-primary-a1 data-dragging:visible",
								),
							],
							[],
						),
						h.ul(
							[h.AriaLabel(group ?? "No group")],
							Arr.map(
								Arr.filter(options.rows, (row) => row.group === group),
								(row) => rowView(h, options, row),
							),
						),
					],
				),
			]),
		),
	])
}

/** What drives a component: its monitor by name, or incidents alone (and the hand-set status). */
export const sourceLine = (monitors: ReadonlyArray<V2UptimeMonitor>, monitorId: string | null): string => {
	if (monitorId === null || monitorId === "") return "No monitor. Follows incidents only"
	const monitor = Arr.findFirst(monitors, (entry) => entry.id === monitorId)
	return monitor._tag === "None" ? "Monitor not found" : `Monitor: ${monitor.value.name}`
}

export type ComponentFieldsOptions<M> = Readonly<{
	/** Prefix of each control's id, unique per page. */
	idPrefix: string
	form: ComponentForm
	monitors: ReadonlyArray<V2UptimeMonitor>
	isReadOnly: boolean
	onField: (field: ComponentTextField, value: string) => M
	onToggleUptime: M
	/** Opens the Group dialog. */
	onOpenGroup: M
}>

/** The component's fields: name, group, description, what drives it, its override and its bars. */
export const componentFields = <M>(
	h: HtmlBuilder<M>,
	options: ComponentFieldsOptions<M>,
): ReadonlyArray<Html> => {
	const { form, isReadOnly, idPrefix } = options
	const hasMonitor = form.monitorId !== ""
	const uptimeId = `${idPrefix}-uptime`
	return [
		grid(h, { sm: 2, gap: "4", className: "items-start" }, [
			textField(h, {
				id: `${idPrefix}-name`,
				label: "Shown as",
				value: form.name,
				isDisabled: isReadOnly,
				error: Str.trim(form.name) === "" ? "Add a name." : null,
				onInput: (value) => options.onField("name", value),
			}),
			buttonField(h, {
				id: `${idPrefix}-group`,
				label: "Group",
				value: Str.trim(form.group),
				placeholder: "No group",
				isDisabled: isReadOnly,
				onClick: options.onOpenGroup,
			}),
		]),
		textField(h, {
			id: `${idPrefix}-description`,
			label: "Description",
			value: form.description,
			placeholder: "Optional",
			isDisabled: isReadOnly,
			onInput: (value) => options.onField("description", value),
		}),
		grid(h, { sm: 2, gap: "4", className: "items-start" }, [
			selectField(h, {
				id: `${idPrefix}-monitor`,
				label: "Driven by",
				value: form.monitorId,
				isDisabled: isReadOnly,
				hint: hasMonitor ? undefined : "Without a monitor, you set its status yourself.",
				entries: [
					{ value: "", label: "No monitor" },
					...Arr.map(options.monitors, (monitor) => ({ value: monitor.id, label: monitor.name })),
				],
				onInput: (value) => options.onField("monitorId", value),
			}),
			selectField(h, {
				id: `${idPrefix}-status`,
				label: "Override status",
				value: form.manualStatus,
				isDisabled: isReadOnly,
				entries: [
					{ value: "", label: "Automatic" },
					...Arr.map(COMPONENT_STATUS_OPTIONS, (value) => ({
						value,
						label: COMPONENT_STATUS_LABEL[value],
					})),
				],
				onInput: (value) => options.onField("manualStatus", value),
			}),
		]),
		vstack(h, { gap: "1" }, [
			label(
				h,
				{
					className: "flex items-center gap-2 font-normal text-sm sm:text-sm",
					attributes: [h.Id(`${uptimeId}-label`)],
				},
				[
					...switchControl(h, {
						// The stored value, shown as is; it only takes effect once a monitor drives the component.
						id: uptimeId,
						inputId: `${uptimeId}-input`,
						isChecked: form.showUptime,
						isDisabled: isReadOnly || !hasMonitor,
						labelledBy: `${uptimeId}-label`,
						onToggle: options.onToggleUptime,
					}),
					"Show uptime bars",
				],
			),
			...(hasMonitor
				? []
				: [typography(h, { size: "xs", tone: "muted", as: "p" }, ["Uptime bars need a monitor."])]),
		]),
	]
}

/** "Remove from page", its text level with the fields above. */
export const removeButton = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isDisabled: boolean; onClick: M }>,
): Html =>
	button(
		h,
		{
			size: "sm",
			variant: "destructive-ghost",
			isDisabled: options.isDisabled,
			className: "-ml-2.5",
			attributes: [h.OnClick(options.onClick)],
		},
		["Remove from page"],
	)
