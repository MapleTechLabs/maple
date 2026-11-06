import type { V2UptimeMonitor } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import * as Checkbox from "@maple/views/ui/checkbox"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { input } from "@maple/views/ui/input"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { label } from "@maple/views/ui/label"
import { COMPONENT_STATUS_LABEL, COMPONENT_STATUS_OPTIONS } from "./derive"
import { checkedRows, monitorTarget, type Picker, PickerMessage, type PickerRow, rowIssue } from "./picker"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { dividedList } from "@maple/views/ui/rule"
import { Array as Arr, String as Str, Option } from "effect"

// The checklist view: checked rows rename, group and move in place; the URL field and the
// add-by-hand row sit under it.

export type PickerViewOptions<M> = Readonly<{
	picker: Picker
	monitors: ReadonlyArray<V2UptimeMonitor>
	toMessage: (message: PickerMessage) => M
	/** Prefix of every control id, unique per page. */
	idPrefix: string
	isDisabled?: boolean
	/** Ordering and grouping apply to new pages only; the editor adds rows at the end. */
	isOrderable?: boolean
	/** An `OnMount` that focuses the element: the name input of a row added by hand gets it. */
	focusOnMount?: Attribute<M>
}>

const rowId = (prefix: string, row: PickerRow, part: string) =>
	`${prefix}-${part}-${Str.replace(":", "-")(row.key)}`

const textInput = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		id: string
		label: string
		value: string
		placeholder: string
		isDisabled: boolean
		error?: string | null
		className?: string
		onInput: (value: string) => M
		extra?: ReadonlyArray<Attribute<M>>
	}>,
): Html =>
	input(h, {
		id: options.id,
		size: "sm",
		isDisabled: options.isDisabled,
		className: options.className,
		attributes: [
			h.AriaLabel(options.label),
			h.Value(options.value),
			h.Placeholder(options.placeholder),
			h.OnInput(options.onInput),
			...(options.extra ?? []),
			...((options.error ?? null) === null
				? []
				: [h.AriaInvalid(true), h.AriaDescribedBy(`${options.id}-error`)]),
		],
	})

const moveButtons = <M>(
	h: HtmlBuilder<M>,
	options: PickerViewOptions<M>,
	row: PickerRow,
	position: Readonly<{ isFirst: boolean; isLast: boolean }>,
): Html => {
	const name = Str.trim(row.name) === "" ? "component" : Str.trim(row.name)
	return hstack(h, { className: "shrink-0" }, [
		iconButton(
			h,
			{
				label: `Move ${name} up`,
				size: "icon-xs",
				isDisabled: options.isDisabled === true || position.isFirst,
				attributes: [
					h.OnClick(options.toMessage(PickerMessage.ClickedMoveRow({ key: row.key, offset: -1 }))),
				],
			},
			[icon(h, "ChevronUpIcon")],
		),
		iconButton(
			h,
			{
				label: `Move ${name} down`,
				size: "icon-xs",
				isDisabled: options.isDisabled === true || position.isLast,
				attributes: [
					h.OnClick(options.toMessage(PickerMessage.ClickedMoveRow({ key: row.key, offset: 1 }))),
				],
			},
			[icon(h, "ChevronDownIcon")],
		),
	])
}

const editFields = <M>(
	h: HtmlBuilder<M>,
	options: PickerViewOptions<M>,
	row: PickerRow,
	label: string,
): Html => {
	const error = rowIssue(row)
	const nameId = rowId(options.idPrefix, row, "name")
	const isDisabled = options.isDisabled === true
	return vstack(h, { gap: "1", shrink: true, grow: true }, [
		h.div(
			[h.Class("grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]")],
			[
				textInput(h, {
					id: nameId,
					// Focused as it mounts, so the first keystroke after "Add" lands in it.
					extra:
						options.focusOnMount !== undefined && options.picker.autofocusKey === row.key
							? [options.focusOnMount]
							: [],
					label: `Shown as, ${label}`,
					value: row.name,
					placeholder: row.monitorId === null ? "Component name" : label,
					isDisabled,
					error,
					onInput: (value) =>
						options.toMessage(PickerMessage.ChangedRowName({ key: row.key, value })),
				}),
				textInput(h, {
					id: rowId(options.idPrefix, row, "group"),
					label: `Group of ${label}`,
					value: row.group,
					placeholder: "Group",
					isDisabled,
					onInput: (value) =>
						options.toMessage(PickerMessage.ChangedRowGroup({ key: row.key, value })),
				}),
			],
		),
		...(error === null
			? []
			: [
					typography(
						h,
						{ size: "xs", tone: "destructive", as: "p", attributes: [h.Id(`${nameId}-error`)] },
						[error],
					),
				]),
	])
}

const statusSelect = <M>(
	h: HtmlBuilder<M>,
	options: PickerViewOptions<M>,
	row: PickerRow,
	label: string,
): Html =>
	nativeSelect(
		h,
		{
			defaultValue: row.manualStatus,
			size: "sm",
			className: "w-36 shrink-0",
			isDisabled: options.isDisabled,
			attributes: [
				h.Key(`${row.key}-${row.manualStatus}`),
				h.AriaLabel(`Status of ${label}`),
				h.OnChange((value) =>
					options.toMessage(PickerMessage.PickedRowStatus({ key: row.key, value })),
				),
			],
		},
		Arr.map(COMPONENT_STATUS_OPTIONS, (status) => nativeOption(status, COMPONENT_STATUS_LABEL[status])),
	)

const monitorRowView = <M>(
	h: HtmlBuilder<M>,
	options: PickerViewOptions<M>,
	row: PickerRow,
	monitor: V2UptimeMonitor | undefined,
	position: Readonly<{ isFirst: boolean; isLast: boolean }>,
): Html => {
	const name = monitor?.name ?? row.name
	const inputId = rowId(options.idPrefix, row, "check")
	const target = monitor === undefined ? "" : monitorTarget(monitor)
	return h.li(
		[
			h.Key(row.key),
			h.Class(cn("flex items-start gap-3 px-3 py-2.5", row.isChecked ? "" : "text-muted-foreground")),
		],
		[
			label(h, { className: "mt-1.5 flex shrink-0", attributes: [h.Id(Checkbox.labelId(inputId))] }, [
				...Checkbox.view(h, {
					model: { isChecked: row.isChecked },
					toParentMessage: () => options.toMessage(PickerMessage.ToggledRow({ key: row.key })),
					id: `${inputId}-root`,
					inputId,
					isDisabled: options.isDisabled,
					ariaLabel: `Show ${name} on the page`,
				}),
			]),
			row.isChecked
				? vstack(h, { gap: "1", shrink: true, grow: true }, [
						editFields(h, options, row, name),
						typography(h, { size: "xs", tone: "muted", mono: true, truncate: true, as: "p" }, [
							target,
						]),
					])
				: h.div(
						[h.Class("flex min-w-0 flex-1 flex-col gap-0.5 pt-1")],
						[
							typography(h, { size: "sm", truncate: true }, [name]),
							typography(h, { size: "xs", mono: true, truncate: true }, [target]),
						],
					),
			...(row.isChecked && options.isOrderable !== false
				? [moveButtons(h, options, row, position)]
				: []),
		],
	)
}

const manualRowView = <M>(
	h: HtmlBuilder<M>,
	options: PickerViewOptions<M>,
	row: PickerRow,
	position: Readonly<{ isFirst: boolean; isLast: boolean }>,
): Html => {
	const label = Str.trim(row.name) === "" ? "the new component" : Str.trim(row.name)
	return h.li(
		[h.Key(row.key), h.Class("flex items-start gap-3 px-3 py-2.5")],
		[
			h.span(
				[h.AriaHidden(true), h.Class("mt-2 flex size-4 shrink-0 items-center justify-center")],
				[icon(h, "PencilIcon", { size: 12, className: "text-muted-foreground" })],
			),
			vstack(h, { gap: "1", shrink: true, grow: true }, [
				editFields(h, options, row, label),
				hstack(h, { gap: "2" }, [
					statusSelect(h, options, row, label),
					typography(h, { size: "xs", tone: "muted" }, ["Updated by hand"]),
				]),
			]),
			hstack(h, { className: "shrink-0" }, [
				...(options.isOrderable === false ? [] : [moveButtons(h, options, row, position)]),
				iconButton(
					h,
					{
						label: `Remove ${label}`,
						size: "icon-xs",
						isDisabled: options.isDisabled,
						attributes: [
							h.OnClick(options.toMessage(PickerMessage.ClickedRemoveRow({ key: row.key }))),
						],
					},
					[icon(h, "XmarkIcon")],
				),
			]),
		],
	)
}

const urlField = <M>(h: HtmlBuilder<M>, options: PickerViewOptions<M>): Html => {
	const picker = options.picker
	const id = `${options.idPrefix}-url`
	if (!picker.isUrlOpen)
		return button(
			h,
			{
				size: "sm",
				variant: "ghost",
				isDisabled: options.isDisabled,
				attributes: [h.OnClick(options.toMessage(PickerMessage.ClickedOpenUrl()))],
			},
			[icon(h, "PlusIcon"), "Monitor a URL"],
		)
	return h.form(
		[
			h.Class("flex w-full max-w-md flex-col gap-1.5"),
			h.OnSubmit(options.toMessage(PickerMessage.SubmittedUrl())),
			h.AriaLabel("Monitor a URL"),
		],
		[
			hstack(h, { gap: "2", wrap: true }, [
				input(h, {
					id,
					size: "sm",
					type: "url",
					className: "min-w-0 flex-1 basis-48",
					controlClassName: "font-mono",
					isDisabled: options.isDisabled === true || picker.isCreatingMonitor,
					attributes: [
						h.AriaLabel("URL to monitor"),
						h.Value(picker.url),
						h.Placeholder("https://api.acme.com"),
						h.OnInput((value) => options.toMessage(PickerMessage.ChangedUrl({ value }))),
						...(picker.urlIssue === null
							? []
							: [h.AriaInvalid(true), h.AriaDescribedBy(`${id}-error`)]),
					],
				}),
				button(
					h,
					{
						size: "sm",
						variant: "outline",
						type: "submit",
						isLoading: picker.isCreatingMonitor,
						isDisabled: options.isDisabled,
					},
					["Monitor it"],
				),
				// Without rows the URL field is all the picker shows, so it stays open.
				...(picker.rows.length === 0
					? []
					: [
							button(
								h,
								{
									size: "sm",
									variant: "ghost",
									isDisabled: picker.isCreatingMonitor,
									attributes: [
										h.OnClick(options.toMessage(PickerMessage.ClickedCancelUrl())),
									],
								},
								["Cancel"],
							),
						]),
			]),
			picker.urlIssue === null
				? typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"Maple checks it every minute and the page shows its uptime.",
					])
				: typography(
						h,
						{ size: "xs", tone: "destructive", as: "p", attributes: [h.Id(`${id}-error`)] },
						[picker.urlIssue],
					),
		],
	)
}

export const pickerView = <M>(h: HtmlBuilder<M>, options: PickerViewOptions<M>): Html => {
	const picker = options.picker
	const checked = checkedRows(picker)
	const positionOf = (row: PickerRow) => ({
		isFirst: checked[0]?.key === row.key,
		isLast: checked.at(-1)?.key === row.key,
	})
	const isEmpty = picker.rows.length === 0
	return vstack(h, { gap: "3" }, [
		...(isEmpty
			? [
					typography(h, { size: "sm", tone: "muted", as: "p" }, [
						"Paste a URL to monitor, or add a component you'll update by hand.",
					]),
				]
			: [
					dividedList(
						h,
						{ as: "ul", attributes: [h.AriaLabel("Components")] },
						Arr.map(picker.rows, (row) =>
							row.monitorId === null
								? manualRowView(h, options, row, positionOf(row))
								: monitorRowView(
										h,
										options,
										row,
										Option.getOrUndefined(
											Arr.findFirst(
												options.monitors,
												(monitor) => monitor.id === row.monitorId,
											),
										),
										positionOf(row),
									),
						),
					),
				]),
		h.div(
			[h.Class("flex flex-col items-start gap-2")],
			[
				urlField(h, options),
				button(
					h,
					{
						size: "sm",
						variant: "ghost",
						isDisabled: options.isDisabled,
						className: "h-auto max-w-full self-start text-left whitespace-normal",
						attributes: [
							h.OnClick(options.toMessage(PickerMessage.ClickedAddManual())),
							// Keys typed before the new row mounts reach the button; they belong to the row.
							h.OnKeyDown((key) => options.toMessage(PickerMessage.PressedKeyOnAdd({ key }))),
						],
					},
					[icon(h, "PlusIcon"), "Add a component without a monitor"],
				),
			],
		),
	])
}
