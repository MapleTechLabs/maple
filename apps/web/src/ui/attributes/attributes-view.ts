import { splitGenAiAttributes } from "@maple/ui/lib/gen-ai"
import { groupAttributesByNamespace } from "@maple/ui/lib/log-attributes"
import { cn } from "@maple/ui/lib/utils"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../display"
import { icon } from "../icon"
import { attributeRow, type RowContext } from "./attribute-row"
import { type AttributeSource, isOpen, Message, type Model } from "./attributes-panel"
import { searchInput } from "../search-input"

// Port of `AttributesTable`, `AttributesSection`, `ResourceAttributesSection` (packages/ui/src/
// components/attributes/attributes-table.tsx) and the log attributes panel.

type H = HtmlBuilder<Message>

/** Base UI `Collapsible`: open renders the panel (with Base UI's settled style), closed drops it. */
const collapsible = (
	h: H,
	model: Model,
	options: Readonly<{
		key: string
		defaultOpen: boolean
		triggerClassName: string
		trigger: ReadonlyArray<Html | string>
		panelClassName?: string
		panel: () => ReadonlyArray<Html>
	}>,
): Html => {
	const open = isOpen(model, options.key, options.defaultOpen)
	const panelId = `${model.id}-${options.key}-panel`
	return h.div(
		[
			h.Key(options.key),
			h.DataAttribute(open ? "open" : "closed", ""),
			h.DataAttribute("slot", "collapsible"),
		],
		[
			h.button(
				[
					...(open ? [h.AriaControls(panelId)] : []),
					h.AriaDisabled(false),
					h.AriaExpanded(open),
					h.Class(options.triggerClassName),
					...(open ? [h.DataAttribute("panel-open", "")] : []),
					h.DataAttribute("slot", "collapsible-trigger"),
					h.Tabindex(0),
					h.Type("button"),
					h.OnClick(
						Message.ToggledCollapsible({ key: options.key, defaultOpen: options.defaultOpen }),
						{
							propagation: "Stop",
						},
					),
				],
				options.trigger,
			),
			...(open
				? [
						h.div(
							[
								h.Class(collapsiblePanelStyles),
								h.DataAttribute("open", ""),
								h.DataAttribute("slot", "collapsible-panel"),
								h.Id(panelId),
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
									"animation-name": "none",
								}),
							],
							[
								h.div(
									options.panelClassName === undefined
										? []
										: [h.Class(options.panelClassName)],
									options.panel(),
								),
							],
						),
					]
				: []),
		],
	)
}

/** Drops the namespace prefix inside its group (`k8s.pod.name` reads `pod.name` under `k8s`). */
const stripNamespace = (key: string, namespace: string): string => {
	if (namespace === "Other") return key
	const prefix = `${namespace}.`
	return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

const filterEntries = (
	entries: ReadonlyArray<readonly [string, string]>,
	query: string,
): ReadonlyArray<readonly [string, string]> => {
	if (query === "") return entries
	const q = query.toLowerCase()
	return entries.filter(([key, value]) => key.toLowerCase().includes(q) || value.toLowerCase().includes(q))
}

const title4 = (h: H, title: string) =>
	h.h4([h.Class("text-xs font-medium tracking-wide text-foreground-soft")], [title])

const noMatches = (h: H, title: string, query: string) =>
	h.div(
		[h.Class("space-y-1.5")],
		[
			title4(h, title),
			h.div(
				[h.Class("text-xs text-muted-foreground py-2")],
				["No ", title.toLowerCase(), ' match "', query, '"'],
			),
		],
	)

type TableOptions = Readonly<{
	attributes: Readonly<Record<string, string>>
	title: string
	/** Collapsible keys and copy ids are scoped by it (`log`, `resource`, `log-internal`). */
	section: string
	isGrouped: boolean
}>

/** `AttributesTable`. */
const attributesTable = (h: H, context: RowContext, options: TableOptions): Html => {
	const { model } = context
	const query = model.search
	const entries = Object.entries(options.attributes)
	if (entries.length === 0)
		return h.div(
			[h.Class("text-xs text-muted-foreground py-2")],
			["No ", options.title.toLowerCase(), " available"],
		)
	const rowContext = { ...context, idPrefix: options.section }
	if (options.isGrouped) {
		const groups = groupAttributesByNamespace({ ...options.attributes })
			.map((group) => ({ ...group, entries: filterEntries(group.entries, query) }))
			.filter((group) => group.entries.length > 0)
		if (groups.length === 0) return noMatches(h, options.title, query)
		return h.div(
			[h.Class("space-y-1.5")],
			[
				title4(h, options.title),
				h.div(
					[h.Class("divide-y divide-border-subtle overflow-hidden rounded-md border")],
					groups.map((group) =>
						collapsible(h, model, {
							key: `${options.section}:${group.namespace}`,
							defaultOpen: group.entries.length <= 8 || query !== "",
							triggerClassName:
								"group flex w-full items-center gap-1.5 px-1.5 py-1.5 text-2xs text-muted-foreground transition-colors hover:bg-surface-sunken hover:text-foreground",
							trigger: [
								icon(h, "ChevronRightIcon", {
									size: 12,
									className: "transition-transform group-data-[panel-open]:rotate-90",
								}),
								h.span(
									[h.Class("font-mono font-semibold text-foreground-soft")],
									[group.namespace],
								),
								badge(h, { variant: "muted", size: "xs", mono: true, className: "ml-auto" }, [
									String(group.entries.length),
								]),
							],
							panel: () => [
								h.div(
									[
										h.Class(
											"divide-y divide-border-subtle border-t border-border-subtle bg-surface-faint",
										),
									],
									group.entries.map(([key, value]) =>
										attributeRow(
											h,
											rowContext,
											key,
											value,
											stripNamespace(key, group.namespace),
										),
									),
								),
							],
						}),
					),
				),
			],
		)
	}
	const filtered = filterEntries(entries, query)
	if (filtered.length === 0) return noMatches(h, options.title, query)
	return h.div(
		[h.Class("space-y-1.5")],
		[
			title4(h, options.title),
			h.div(
				[h.Class("divide-y divide-border-subtle overflow-hidden rounded-md border")],
				filtered.map(([key, value]) => attributeRow(h, rowContext, key, value)),
			),
		],
	)
}

/**
 * `AttributesSection`: the raw table with `maple_*` keys lifted into a collapsed "Maple internal"
 * table. TODO(gen-ai): `GenAiSection` for `gen_ai.*` groups is not ported; those keys are dropped.
 */
export const attributesSection = (h: H, context: RowContext, options: TableOptions): Html => {
	const { groups, rest } = splitGenAiAttributes({ ...options.attributes })
	const entries = Object.entries(rest)
	const standard = Object.fromEntries(entries.filter(([key]) => !key.startsWith("maple_")))
	const internal = Object.fromEntries(entries.filter(([key]) => key.startsWith("maple_")))
	const internalCount = Object.keys(internal).length
	const showRawTable = Object.keys(standard).length > 0 || groups.length === 0
	return h.div(
		[h.Class("space-y-2")],
		[
			...(showRawTable ? [attributesTable(h, context, { ...options, attributes: standard })] : []),
			...(internalCount > 0
				? [
						collapsible(h, context.model, {
							key: `${options.section}:internal`,
							defaultOpen: false,
							triggerClassName:
								"flex items-center gap-1 text-3xs text-muted-foreground hover:text-foreground transition-colors group",
							trigger: [
								icon(h, "ChevronRightIcon", {
									size: 10,
									className: "transition-transform group-data-[panel-open]:rotate-90",
								}),
								"Maple internal (",
								String(internalCount),
								")",
							],
							panel: () => [
								h.div(
									[h.Class("mt-1")],
									[
										attributesTable(h, context, {
											attributes: internal,
											title: "Maple internal",
											section: `${options.section}-internal`,
											isGrouped: false,
										}),
									],
								),
							],
						}),
					]
				: []),
		],
	)
}

export type PanelInputs = Readonly<{
	logAttributes: Readonly<Record<string, string>>
	resourceAttributes: Readonly<Record<string, string>>
	/** Every attribute row grows "Filter" / "Exclude" hover actions. */
	canFilter: boolean
	/** The log section's heading (apps/local-ui says "Log attributes"). */
	logTitle?: string
	/** The dashboard renders commit SHAs as commit links; apps/local-ui shows them as text. */
	hasCommitShaValues?: boolean
}>

const attributesSearch = (h: H, model: Model): Html =>
	searchInput(h, {
		id: `${model.id}-search`,
		size: "sm",
		placeholder: "Search attributes…",
		value: model.search,
		onInput: (text) => Message.ChangedSearch({ text }),
		onClear: Message.ChangedSearch({ text: "" }),
	})

const sectionOf = (h: H, model: Model, inputs: PanelInputs, source: AttributeSource, title: string) =>
	attributesSection(
		h,
		{
			model,
			source,
			canFilter: inputs.canFilter,
			idPrefix: source,
			hasCommitShaValues: inputs.hasCommitShaValues,
		},
		{
			attributes: source === "log" ? inputs.logAttributes : inputs.resourceAttributes,
			title,
			section: source,
			isGrouped: true,
		},
	)

export type TableInputs = Readonly<{ attributes: Readonly<Record<string, string>>; title: string }>

/** A bare `<AttributesTable attributes title />`: ungrouped, unsearched, copy only. */
export const tableView = Submodel.defineView<Model, Message, TableInputs>((model, inputs, h) =>
	attributesTable(
		h,
		{ model, source: "log", canFilter: false, idPrefix: "table" },
		{ attributes: inputs.attributes, title: inputs.title, section: "table", isGrouped: false },
	),
)

/** `LogAttributesPanel`: the search box, then the log and resource attribute sections. */
export const view = Submodel.defineView<Model, Message, PanelInputs>((model, inputs, h) =>
	h.div(
		[h.Class(cn("space-y-3"))],
		[
			...(Object.keys(inputs.logAttributes).length > 0 ||
			Object.keys(inputs.resourceAttributes).length > 0
				? [attributesSearch(h, model)]
				: []),
			sectionOf(h, model, inputs, "log", inputs.logTitle ?? "Log Attributes"),
			sectionOf(h, model, inputs, "resource", "Resource attributes"),
		],
	),
)
