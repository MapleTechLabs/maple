import { splitGenAiAttributes, type GenAiGroup } from "@maple/ui/lib/gen-ai"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { capForDisplay, prettyJson, tryParseJson } from "../../../../lib/display-text"
import { attributeFilterAction } from "../../../../ui/attributes/attribute-row"
import { collapsible } from "../../../../ui/collapsible"
import { heading } from "../../../../ui/heading"
import { icon } from "../../../../ui/icon"
import { truncationNote } from "../../../../ui/logs/log-message"
import { pressable } from "../../../../ui/pressable"
import { copyableValue, copyButton, selectableValue } from "./copy"
import { type AttributeScope, Message } from "./message"
import type { PanelState as Model } from "./model"

// `AttributesSection` / `AttributesTable` / `AttributeRow` (packages/ui/src/components/attributes)
// with filter actions and a value renderer that links commit SHAs.
// TODO(json-highlight): an expanded JSON value renders plain; it should highlight like `CollapsibleJsonValue`.

type H = HtmlBuilder<Message>
type Entries = ReadonlyArray<readonly [string, string]>

const FULL_SHA = /^[0-9a-f]{40}$/i

const filterAction = (h: H, label: string, onClick: Message, text: string): Html =>
	attributeFilterAction(h, { label, onClick, text })

/** `CommitShaAttributeValue`: the hover-card trigger (the card itself is not ported). */
const commitShaValue = (h: H, id: string, value: string): Html => {
	const className = cn(
		"cursor-pointer",
		"-mx-0.5 cursor-pointer break-all rounded-sm px-0.5 hover:bg-surface-sunken active:bg-surface-sunken",
	)
	const onClick = Message.ClickedCopy({ id, text: value })
	return FULL_SHA.test(value)
		? pressable(
				h,
				{ onClick, className, attributes: [h.DataAttribute("slot", "hover-card-trigger")] },
				[value],
			)
		: pressable(h, { onClick, className }, [value])
}

const jsonValue = (h: H, model: Model, id: string, value: string): Html => {
	const isOpen = model.openIds.includes(id)
	// Re-indented only once opened: a collapsed row shows an 80-character preview.
	const formatted = isOpen ? Option.getOrElse(prettyJson(value), () => value) : ""
	const { shown, omitted } = capForDisplay(formatted)
	return h.div(
		[h.Class("min-w-0")],
		[
			pressable(
				h,
				{
					onClick: Message.ToggledCollapsible({ id }),
					className:
						"flex items-start gap-1 w-full text-left font-mono text-xs break-all cursor-pointer hover:bg-surface-sunken active:bg-surface-sunken rounded-sm px-0.5 -mx-0.5",
					attributes: [h.Title(isOpen ? "Collapse" : "Expand JSON")],
				},
				[
					icon(h, "ChevronRightIcon", {
						size: 12,
						className: `shrink-0 mt-0.5 transition-transform ${isOpen ? "rotate-90" : ""}`,
					}),
					isOpen
						? h.span([h.Class("text-muted-foreground")], ["JSON"])
						: h.span([], [value.length > 80 ? value.slice(0, 80) + "…" : value]),
				],
			),
			...(isOpen
				? [
						h.div(
							[
								h.Class(
									"group/json relative mt-1 overflow-hidden rounded-md border bg-surface-sunken",
								),
							],
							[
								h.div(
									[h.Class("max-h-64 overflow-auto p-2")],
									[
										...(omitted === 0
											? []
											: [truncationNote(h, shown.length, formatted.length)]),
										h.pre([h.Class("text-xs leading-relaxed")], [h.code([], [shown])]),
									],
								),
								copyButton(h, model, {
									id: `${id}:json`,
									value,
									label: "JSON",
									iconSize: 10,
									tooltipId: `${id}:json-tooltip`,
									className:
										"absolute top-1 right-1 border-border-subtle bg-background/80 opacity-0 backdrop-blur-sm transition-opacity focus-visible:opacity-100 group-hover/json:opacity-100 pointer-coarse:opacity-100",
								}),
							],
						),
					]
				: []),
		],
	)
}

type RowInput = Readonly<{
	scope: AttributeScope
	attrKey: string
	value: string
	displayKey?: string
	displayValue?: string
	plainKey?: boolean
	/** `onFilterByAttribute` is in scope: the row grows its Filter and Exclude verbs. */
	isFilterable: boolean
}>

/** `AttributeRow`: copyable key, selectable value (or JSON / commit SHA) and the filter verbs. */
const attributeRow = (h: H, model: Model, row: RowInput): Html => {
	const id = `attr:${row.scope}:${row.attrKey}`
	const shown = row.displayValue ?? row.value
	const parsed =
		row.displayValue !== undefined && row.displayValue !== row.value
			? Option.none()
			: tryParseJson(row.value)
	const valueNode = Option.match(parsed, {
		onSome: () => jsonValue(h, model, `json:${id}`, row.value),
		onNone: () =>
			row.attrKey === "vcs.ref.head.revision"
				? commitShaValue(h, `sha:${id}`, row.value)
				: selectableValue(
						h,
						model,
						{
							id: `sel:${id}`,
							value: row.value,
							label: row.attrKey,
							textClassName:
								row.value.length > 400 ? "block max-h-48 overflow-y-auto" : undefined,
						},
						[shown === "" ? h.span([h.Class("text-muted-foreground")], ['""']) : shown],
					),
	})
	return h.div(
		[
			h.Class(
				"group/attr grid grid-cols-[minmax(7rem,38%)_1fr] items-start gap-x-3 px-2 py-1 hover:bg-surface-sunken active:bg-surface-sunken",
			),
		],
		[
			copyableValue(
				h,
				model,
				{
					id: `key:${id}`,
					value: row.attrKey,
					label: "attribute key",
					className: cn(
						"text-2xs leading-relaxed text-muted-foreground break-words",
						row.plainKey !== true && "font-mono",
					),
				},
				[row.displayKey ?? row.attrKey],
			),
			h.div(
				[h.Class("min-w-0 font-mono text-2xs leading-relaxed text-foreground break-all")],
				[
					valueNode,
					...(Option.isSome(parsed) || !row.isFilterable
						? []
						: [
								h.span(
									[
										h.Class(
											"ml-2 inline-flex items-center gap-1 align-middle opacity-0 transition-opacity group-hover/attr:opacity-100 group-focus-within/attr:opacity-100 pointer-coarse:opacity-100",
										),
									],
									[
										filterAction(
											h,
											`Filter by ${row.attrKey} = ${row.value}`,
											Message.ClickedAttributeFilter({
												...pick(row),
												isExclude: false,
											}),
											"Filter",
										),
										filterAction(
											h,
											`Exclude ${row.attrKey} = ${row.value}`,
											Message.ClickedAttributeFilter({ ...pick(row), isExclude: true }),
											"Exclude",
										),
									],
								),
							]),
				],
			),
		],
	)
}

const pick = (row: RowInput) => ({ scope: row.scope, key: row.attrKey, value: row.value })

const tableTitle = (h: H, title: string): Html =>
	heading(h, { level: 4, variant: "label" }, [title])

/** `AttributesTable` without search or namespace grouping (the span panel uses neither). */
const attributesTable = (
	h: H,
	model: Model,
	scope: AttributeScope,
	entries: Entries,
	title: string,
	isFilterable: boolean,
): Html =>
	entries.length === 0
		? h.div([h.Class("text-xs text-muted-foreground py-2")], [`No ${title.toLowerCase()} available`])
		: h.div(
				[h.Class("space-y-1.5")],
				[
					tableTitle(h, title),
					h.div(
						[h.Class("divide-y divide-border-subtle overflow-hidden rounded-md border")],
						entries.map(([attrKey, value]) =>
							attributeRow(h, model, { scope, attrKey, value, isFilterable }),
						),
					),
				],
			)

/** `GenAiSection`: the `gen_ai.*` fields under plain-language labels. */
const genAiSection = (
	h: H,
	model: Model,
	scope: AttributeScope,
	groups: ReadonlyArray<GenAiGroup>,
	isFilterable: boolean,
): Html | null =>
	groups.length === 0
		? null
		: h.div(
				[h.Class("space-y-1.5")],
				[
					tableTitle(h, "AI attributes"),
					h.div(
						[h.Class("divide-y divide-border-subtle overflow-hidden rounded-md border")],
						groups.map((group) =>
							h.div(
								[],
								[
									h.div(
										[
											h.Class(
												"px-1.5 py-1.5 text-2xs font-semibold tracking-wide text-foreground-soft",
											),
										],
										[group.label],
									),
									h.div(
										[
											h.Class(
												"divide-y divide-border-subtle border-t border-border-subtle bg-surface-faint",
											),
										],
										group.fields.map((field) =>
											attributeRow(h, model, {
												scope,
												attrKey: field.key,
												value: field.rawValue,
												displayKey: field.label,
												displayValue: field.value,
												plainKey: true,
												isFilterable,
											}),
										),
									),
								],
							),
						),
					),
				],
			)

/** `AttributesSection`: AI block, the raw table, and Maple's own `maple_` keys collapsed below. */
export const attributesSection = (
	h: H,
	model: Model,
	scope: AttributeScope,
	attributes: Readonly<Record<string, string>>,
	title: string,
	options: Readonly<{ isFilterable?: boolean }> = {},
): Html => {
	const isFilterable = options.isFilterable ?? true
	const { groups, rest } = splitGenAiAttributes({ ...attributes })
	const entries = Object.entries(rest)
	const standard = entries.filter(([key]) => !key.startsWith("maple_"))
	const internal = entries.filter(([key]) => key.startsWith("maple_"))
	const internalId = `internal:${scope}`
	const isInternalOpen = model.openIds.includes(internalId)
	return h.div(
		[h.Class("space-y-2")],
		[
			genAiSection(h, model, scope, groups, isFilterable),
			standard.length > 0 || groups.length === 0
				? attributesTable(h, model, scope, standard, title, isFilterable)
				: null,
			...(internal.length === 0
				? []
				: [
						collapsible(
							h,
							{
								isOpen: isInternalOpen,
								onToggle: Message.ToggledCollapsible({ id: internalId }),
								panelId: `${internalId}-panel`,
								triggerClassName:
									"flex items-center gap-1 text-3xs text-muted-foreground hover:text-foreground active:text-foreground group",
								panelClassName: "mt-1",
								trigger: [
									icon(h, "ChevronRightIcon", {
										size: 10,
										className: "transition-transform group-data-[panel-open]:rotate-90",
									}),
									"Maple internal (",
									String(internal.length),
									")",
								],
							},
							[attributesTable(h, model, scope, internal, "Maple internal", isFilterable)],
						),
					]),
		],
	)
}
