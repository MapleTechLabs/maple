import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { prettyJson, tryParseJson } from "../../lib/display-text"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { copyButton } from "../copy-button"
import { icon } from "../icon"
import { cappedCode } from "../logs/log-message"
import { type AttributeSource, copyStatusOf, isOpen, Message, type Model } from "./attributes-panel"

// Port of `CopyableValue`, `SelectableValue`, `AttributeRow` (packages/ui/src/components/attributes/
// attributes-table.tsx) and `CollapsibleJsonValue` (json-value.tsx), against an AttributesPanel Model.

type H = HtmlBuilder<Message>

const stop = { propagation: "Stop" } as const

/** `CopyableValue`: inline text that copies itself, tinted by the copy's outcome. */
export const copyableValue = (
	h: H,
	model: Model,
	options: Readonly<{ id: string; value: string; label?: string; className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const status = copyStatusOf(model, options.id)
	return h.button(
		[
			h.Type("button"),
			h.AriaLabel(`Copy ${options.label ?? "value"}`),
			h.Class(
				cn(
					"-mx-0.5 cursor-pointer rounded-sm px-0.5 text-left transition-colors",
					status === "idle" && "hover:bg-surface-sunken",
					status === "copied" && "bg-severity-info/20",
					status === "error" && "bg-severity-error/20",
					options.className,
				),
			),
			h.OnClick(Message.ClickedCopy({ copyId: options.id, text: options.value }), stop),
			h.Title("Click to copy"),
		],
		children,
	)
}

/** `SelectableValue`: selectable text with a trailing copy button for the whole value. */
const selectableValue = (
	h: H,
	model: Model,
	options: Readonly<{ id: string; value: string; label: string; textClassName?: string }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.span(
		[h.Class("group/sel")],
		[
			h.span([h.Class(cn("select-text", options.textClassName))], children),
			copyButton(h, {
				status: copyStatusOf(model, options.id),
				label: options.label,
				iconSize: 10,
				className:
					"-my-1 ml-1 size-5 shrink-0 align-middle opacity-0 transition-opacity group-hover/sel:opacity-100 group-hover/attr:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 sm:size-5",
				attributes: [
					h.OnClick(Message.ClickedCopy({ copyId: options.id, text: options.value }), stop),
				],
			}),
		],
	)

/** `CollapsibleJsonValue`: an 80-char preview that expands into highlighted, copyable JSON. */
const jsonValue = (h: H, model: Model, id: string, value: string): Html => {
	const isExpanded = isOpen(model, `json:${id}`, false)
	const preview = value.length > 80 ? value.slice(0, 80) + "…" : value
	return h.div(
		[h.Class("min-w-0")],
		[
			h.button(
				[
					h.Type("button"),
					h.Class(
						"flex items-start gap-1 w-full text-left font-mono text-xs break-all cursor-pointer hover:bg-surface-sunken rounded-sm px-0.5 -mx-0.5 transition-colors",
					),
					h.OnClick(Message.ToggledCollapsible({ key: `json:${id}`, defaultOpen: false }), stop),
					h.Title(isExpanded ? "Collapse" : "Expand JSON"),
				],
				[
					icon(h, "ChevronRightIcon", {
						size: 12,
						className: `shrink-0 mt-0.5 transition-transform ${isExpanded ? "rotate-90" : ""}`,
					}),
					isExpanded ? h.span([h.Class("text-muted-foreground")], ["JSON"]) : h.span([], [preview]),
				],
			),
			...(isExpanded
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
										// Re-indented only once expanded: a collapsed row shows an 80-character preview.
										...cappedCode(
											h,
											Option.getOrElse(prettyJson(value), () => value),
											"text-xs leading-relaxed",
										),
									],
								),
								// TODO(copy-tooltip): wrap this CopyButton in its tooltip.
								copyButton(h, {
									status: copyStatusOf(model, `json:${id}`),
									label: "JSON",
									iconSize: 10,
									className:
										"absolute top-1 right-1 border-border-subtle bg-background/80 opacity-0 backdrop-blur-sm transition-opacity focus-visible:opacity-100 group-hover/json:opacity-100 pointer-coarse:opacity-100",
									attributes: [
										h.OnClick(
											Message.ClickedCopy({ copyId: `json:${id}`, text: value }),
											stop,
										),
									],
								}),
							],
						),
					]
				: []),
		],
	)
}

const COMMIT_SHA_KEYS = new Set(["vcs.ref.head.revision"])
const FULL_SHA = /^[0-9a-f]{40}$/i
const COMMIT_SHA_CLASS = "-mx-0.5 cursor-pointer break-all rounded-sm px-0.5 transition-colors hover:bg-surface-sunken"

/** A commit SHA value as a commit link. TODO(commit-card): the hover card itself. */
const commitShaValue = (h: H, id: string, value: string): Html =>
	h.button(
		[
			h.Type("button"),
			...(FULL_SHA.test(value)
				? [
						h.Class(COMMIT_SHA_CLASS),
						h.DataAttribute("slot", "hover-card-trigger"),
						h.Id(`${id}-sha`),
					]
				: [h.Class(cn("cursor-pointer", COMMIT_SHA_CLASS))]),
			h.OnClick(Message.ClickedCopy({ copyId: `sha:${id}`, text: value }), stop),
		],
		[value],
	)

/** The per-row hover verb (`AttributeFilterAction`): the `tag` badge as a button. */
export const attributeFilterAction = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ label: string; text: string; onClick: M; stopPropagation?: boolean }>,
): Html =>
	h.button(
		[
			h.Type("button"),
			h.AriaLabel(options.label),
			h.Title(options.label),
			h.Class(
				cn(
					badgeVariants({
						variant: "tag",
						className: "bg-transparent font-sans transition-colors",
					}),
				),
			),
			h.DataAttribute("slot", "badge"),
			options.stopPropagation === true ? h.OnClick(options.onClick, stop) : h.OnClick(options.onClick),
		],
		[options.text],
	)

const filterAction = (h: H, label: string, onClick: Message, text: string): Html =>
	attributeFilterAction(h, { label, onClick, text, stopPropagation: true })

export type RowContext = Readonly<{
	model: Model
	source: AttributeSource
	canFilter: boolean
	idPrefix: string
	/** Renders commit SHAs as commit links; apps/local-ui has none (default true). */
	hasCommitShaValues?: boolean
}>

/** `AttributeRow`: the key (copyable) and its value (JSON, commit SHA or selectable text), plus filters. */
export const attributeRow = (
	h: H,
	context: RowContext,
	attrKey: string,
	value: string,
	displayKey?: string,
): Html => {
	const { model, source } = context
	const id = `${context.idPrefix}:${attrKey}`
	const parsed = tryParseJson(value)
	const isFilterable = context.canFilter && Option.isNone(parsed)
	const valueView = Option.match(parsed, {
		onSome: () => jsonValue(h, model, id, value),
		onNone: () =>
			COMMIT_SHA_KEYS.has(attrKey) && context.hasCommitShaValues !== false
				? commitShaValue(h, id, value)
				: selectableValue(
						h,
						model,
						{
							id: `value:${id}`,
							value,
							label: attrKey,
							// A 4KB db.statement scrolls in place instead of pushing every other attribute away.
							textClassName: value.length > 400 ? "block max-h-48 overflow-y-auto" : undefined,
						},
						[value === "" ? h.span([h.Class("text-muted-foreground")], ['""']) : value],
					),
	})
	return h.div(
		[
			h.Key(attrKey),
			h.Class(
				"group/attr grid grid-cols-[minmax(7rem,38%)_1fr] items-start gap-x-3 px-2 py-1 transition-colors hover:bg-surface-sunken",
			),
		],
		[
			copyableValue(
				h,
				model,
				{
					id: `key:${id}`,
					value: attrKey,
					label: "attribute key",
					className: "text-2xs leading-relaxed text-muted-foreground break-words font-mono",
				},
				[displayKey ?? attrKey],
			),
			h.div(
				[h.Class("min-w-0 font-mono text-2xs leading-relaxed text-foreground break-all")],
				[
					valueView,
					...(isFilterable
						? [
								h.span(
									[
										h.Class(
											"ml-2 inline-flex items-center gap-1 align-middle opacity-0 transition-opacity group-hover/attr:opacity-100 group-focus-within/attr:opacity-100 pointer-coarse:opacity-100",
										),
									],
									[
										filterAction(
											h,
											`Filter by ${attrKey} = ${value}`,
											Message.ClickedFilter({
												source,
												key: attrKey,
												value,
												negated: false,
											}),
											"Filter",
										),
										filterAction(
											h,
											`Exclude ${attrKey} = ${value}`,
											Message.ClickedFilter({
												source,
												key: attrKey,
												value,
												negated: true,
											}),
											"Exclude",
										),
									],
								),
							]
						: []),
				],
			),
		],
	)
}
