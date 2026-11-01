import { WIDGET_UNITS } from "@maple/domain/http"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"
import type { ListColumn } from "./editor-state"
import { GRIP_ATTRIBUTE, ROW_ATTRIBUTE } from "./list-column-drag"
import { Message } from "./message"
import type { Model } from "./model"
import { ProductEdit } from "./product-edit"
import { listAlignSelectId, listUnitSelectId } from "./product-selects"
import { pageSelect } from "./view-select"

// `DraggableColumnRow`: grip, field (with its suggestions while focused),
// header, unit, alignment and remove. The grip drags (`MountListColumnDrag`) or moves by arrow key.

type H = HtmlBuilder<Message>

const product = (edit: ProductEdit): Message => Message.ChangedProduct({ edit })

const UNIT_OPTIONS = WIDGET_UNITS.map((unit) => ({ value: unit.token, label: unit.label }))
const ALIGN_OPTIONS = [
	{ value: "left", label: "Left" },
	{ value: "center", label: "Center" },
	{ value: "right", label: "Right" },
]

const suggestionList = (h: H, column: ListColumn, index: number, fields: ReadonlyArray<string>): Html =>
	h.div(
		[
			h.Class(
				"absolute top-full left-0 z-50 mt-1 w-full max-h-48 overflow-auto rounded-md border bg-popover shadow-popup",
			),
		],
		fields
			.filter((field) => !column.field || field.toLowerCase().includes(column.field.toLowerCase()))
			.slice(0, 20)
			.map((field) =>
				h.button(
					[
						h.Type("button"),
						h.Class(
							"w-full px-2 py-1 text-left text-xs hover:bg-accent active:bg-accent truncate",
						),
						h.OnMouseDown(product(ProductEdit.PickedListField({ index, field }))),
					],
					[field],
				),
			),
	)

const contents = (h: H) => (parts: ReadonlyArray<Html>) => h.div([h.Class("contents")], parts)

export const listColumnRow = (
	h: H,
	model: Model,
	column: ListColumn,
	index: number,
	suggestions: ReadonlyArray<string> | null,
): Html =>
	h.div(
		[
			h.Class("relative flex items-center gap-2 rounded-md bg-background py-1"),
			h.DataAttribute(ROW_ATTRIBUTE, ""),
		],
		[
			h.button(
				[
					h.Type("button"),
					h.DataAttribute(GRIP_ATTRIBUTE, ""),
					h.AriaLabel(`Reorder ${column.header || column.field || `column ${index + 1}`}`),
					h.Class(
						"shrink-0 cursor-grab touch-none text-foreground-faint hover:text-muted-foreground active:text-muted-foreground active:cursor-grabbing",
					),
					h.OnKeyDownPreventDefault((key) =>
						key === "ArrowUp"
							? Option.some(product(ProductEdit.MovedListColumn({ index, delta: -1 })))
							: key === "ArrowDown"
								? Option.some(product(ProductEdit.MovedListColumn({ index, delta: 1 })))
								: Option.none(),
					),
				],
				[icon(h, "GripDotsIcon", { size: 14 })],
			),
			h.div(
				[h.Class("relative flex-1")],
				[
					input(h, {
						id: `widget-list-field-${index}`,
						className: "text-xs h-8",
						attributes: [
							h.Value(column.field),
							h.Placeholder("Field path"),
							h.OnInput((value) =>
								product(ProductEdit.ChangedListColumnText({ index, field: "field", value })),
							),
							h.OnFocus(Message.FocusedListField({ index })),
							h.OnBlur(Message.BlurredListField()),
						],
					}),
					...(suggestions === null ? [] : [suggestionList(h, column, index, suggestions)]),
				],
			),
			input(h, {
				id: `widget-list-header-${index}`,
				className: "text-xs h-8 w-28",
				attributes: [
					h.Value(column.header),
					h.Placeholder("Header"),
					h.OnInput((value) =>
						product(ProductEdit.ChangedListColumnText({ index, field: "header", value })),
					),
				],
			}),
			pageSelect(h, model, listUnitSelectId(index), column.unit ?? "none", UNIT_OPTIONS, {
				size: "sm",
				className: "w-24",
				toView: contents(h),
			}),
			pageSelect(h, model, listAlignSelectId(index), column.align ?? "left", ALIGN_OPTIONS, {
				size: "sm",
				className: "w-20",
				toView: contents(h),
			}),
			iconButton(
				h,
				{
					size: "icon",
					label: "Remove column",
					className: "text-muted-foreground hover:text-destructive active:text-destructive",
					attributes: [h.OnClick(product(ProductEdit.RemovedListColumn({ index })))],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	)
