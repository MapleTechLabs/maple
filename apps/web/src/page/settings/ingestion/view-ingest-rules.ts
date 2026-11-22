import { fromV2IngestRuleAction, type V2IngestRule } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { lockedControl } from "@maple/views/ui/locked-control"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { miniBars } from "@maple/views/ui/mini-bars"
import * as Menu from "@maple/views/ui/menu"
import type * as MenuView from "@maple/views/ui/menu-view"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { skeleton, skeletonList, skeletonSwitch } from "@maple/views/ui/skeleton"
import { switchControl } from "@maple/views/ui/switch"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { newRuleHref } from "../ingest-rule/hrefs"
import { SIGNAL_LABELS, summaryParts } from "../ingest-rule/summary"
import { TEMPLATE_IDS, TEMPLATES } from "../ingest-rule/templates"
import { settingsSection } from "../../kit/settings-section"
import { denialReason } from "../../kit/session-grants"
import { detail, effectOf, headline, hourlySeries } from "../ingest-rule/impact"
import { menuIdOf, Message as RulesMessage, type Model } from "./ingest-rules"
import { Message } from "./message"
import { ruleSuggestions } from "./view-rule-suggestions"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Option } from "effect"
import { hstack, vstack } from "@maple/views/ui/stack"

const lift = (message: RulesMessage): Message => Message.GotIngestRulesMessage({ message })

type H = HtmlBuilder<Message>

const ACTION_BADGE = {
	drop: { label: "Drop", variant: "warn" },
	redact: { label: "Redact", variant: "info" },
} as const

const DENIAL = denialReason("ingest_rules:manage")

/** `control` as is, or locked with the denial for a viewer who cannot manage rules. */
const gate = (h: H, canManage: boolean, control: Html): Html =>
	canManage ? control : lockedControl(h, DENIAL, control)

/** A link to the rule editor, or the same label disabled with the denial for a viewer who cannot manage rules. */
const ruleLink = (
	h: H,
	canManage: boolean,
	options: Readonly<{ href: string; variant?: "outline" }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	canManage
		? linkButton(h, { size: "sm", ...options }, children)
		: lockedControl(
				h,
				DENIAL,
				button(h, { size: "sm", variant: options.variant, isDisabled: true }, children),
			)

const addRuleButton = (h: H, canManage: boolean) =>
	ruleLink(h, canManage, { href: newRuleHref() }, [
		icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
		"Add rule",
	])

const summary = (h: H, rule: V2IngestRule): Html =>
	typography(
		h,
		{ size: "xs", tone: "muted", className: "min-w-0 break-words" },
		Arr.map(
			summaryParts({ conditions: rule.conditions, action: fromV2IngestRuleAction(rule.action) }),
			(part) =>
				part._tag === "code"
					? inlineCode(h, { variant: "plain", className: "text-foreground break-all" }, [part.text])
					: part.text,
		),
	)

const rowEntries = (canManage: boolean, index: number, count: number): ReadonlyArray<MenuView.MenuEntry> => {
	const locked = canManage ? {} : { isDisabled: true, tooltip: { content: [DENIAL] } }
	const up: MenuView.MenuEntry = {
		_tag: "Item",
		value: "up",
		label: "Move up",
		icon: "ArrowUpIcon",
		...locked,
	}
	const down: MenuView.MenuEntry = {
		_tag: "Item",
		value: "down",
		label: "Move down",
		icon: "ArrowDownIcon",
		...locked,
	}
	return [
		{ _tag: "Item", value: "edit", label: "Edit rule", icon: "PencilIcon", ...locked },
		...(index > 0 ? [up] : []),
		...(index < count - 1 ? [down] : []),
		{
			_tag: "Item",
			value: "delete",
			label: "Delete rule",
			icon: "TrashIcon",
			variant: "destructive",
			...locked,
		},
	]
}

const muted = (h: H, text: string): Html => typography(h, { size: "xs", tone: "muted" }, [text])

/** Last 24h: what the rule did, the bytes or records behind it, and its effect per hour; `-` when the stats did not load. */
const hitsCell = (h: H, model: Model, rule: V2IngestRule): Html => {
	const content = AsyncData.matchData(model.stats, {
		onEmpty: () => [skeleton(h, "h-3.5 w-16")],
		onFailure: () => [muted(h, "-")],
		onData: (stats) => {
			const found = Arr.findFirst(stats.rules, (entry) => entry.id === rule.id)
			if (Option.isNone(found) || found.value.matched === 0) return [muted(h, "No hits")]
			const totals = found.value
			return [
				typography(h, { size: "xs", numeric: true }, [headline(rule.action, totals)]),
				typography(h, { size: "2xs", tone: "muted", numeric: true, truncate: true }, [
					detail(rule.action, totals),
				]),
				miniBars(h, {
					values: hourlySeries(stats, rule.id, 24, (entry) => effectOf(rule.action, entry)),
					// Empty hours draw a baseline so a single busy hour reads as a chart, not a stray tick.
					floor: 12.5,
					floorColor: "var(--input)",
					gap: 1,
					className: "text-muted-foreground h-3 w-full",
					label: `${rule.name}: ${rule.action.type === "drop" ? "records dropped" : "values redacted"} per hour`,
				}),
			]
		},
	})
	return h.div([h.Class("hidden w-32 shrink-0 flex-col gap-1 sm:flex")], content)
}

const ruleRow = (
	h: H,
	model: Model,
	canManage: boolean,
	rule: V2IngestRule,
	index: number,
	count: number,
): Html => {
	const menuId = menuIdOf(rule.id)
	const action = ACTION_BADGE[rule.action.type]
	return h.div(
		[
			h.Key(rule.id),
			h.Class(
				cn(
					"hover:bg-surface-sunken active:bg-surface-sunken flex items-center gap-3 border-t px-4 py-2.5",
					!rule.enabled && "text-muted-foreground",
				),
			),
		],
		[
			vstack(h, { gap: "1", className: "w-28 shrink-0 md:w-40" }, [
				truncatedText(h, { text: rule.name, className: "text-sm" }),
				typography(h, { size: "2xs", tone: "muted" }, [
					Arr.join(
						Arr.map(rule.signals, (signal) => SIGNAL_LABELS[signal]),
						", ",
					),
				]),
			]),
			h.div(
				[h.Class("w-16 shrink-0")],
				[badge(h, { variant: action.variant, size: "sm" }, [action.label])],
			),
			hstack(h, { align: "stretch", shrink: true, grow: true }, [summary(h, rule)]),
			hitsCell(h, model, rule),
			hstack(h, { align: "center", className: "w-10 shrink-0" }, [
				gate(
					h,
					canManage,
					hstack(
						h,
						{ inline: true, as: "span" },
						switchControl(h, {
							id: `${menuId}-switch`,
							inputId: `${menuId}-switch-input`,
							isChecked: rule.enabled,
							isDisabled: !canManage || model.pending.includes(rule.id),
							ariaLabel: `${rule.enabled ? "Turn off" : "Turn on"} ${rule.name}`,
							onToggle: lift(RulesMessage.Toggled({ id: rule.id })),
						}),
					),
				),
			]),
			hstack(h, { align: "stretch", justify: "end", className: "w-7 shrink-0" }, [
				rowActionsMenu(h, {
					slotId: menuId,
					model: model.menus[menuId] ?? Menu.init(menuId),
					entries: rowEntries(canManage, index, count),
					label: `Actions for ${rule.name}`,
					toParentMessage: (message) => lift(RulesMessage.GotRowMenuMessage({ menuId, message })),
				}),
			]),
		],
	)
}

const rulesTable = (h: H, model: Model, canManage: boolean, rules: ReadonlyArray<V2IngestRule>): Html =>
	h.div(
		[],
		[
			hstack(h, { gap: "3", align: "center", className: "px-4 py-1.5" }, [
				eyebrow(h, { variant: "mono", className: "w-28 shrink-0 md:w-40", as: "div" }, ["Name"]),
				eyebrow(h, { variant: "mono", className: "w-16 shrink-0", as: "div" }, ["Action"]),
				eyebrow(h, { variant: "mono", className: "min-w-0 flex-1", as: "div" }, ["Rule"]),
				eyebrow(h, { variant: "mono", className: "hidden w-32 shrink-0 sm:block", as: "div" }, [
					"Last 24h",
				]),
				eyebrow(h, { variant: "mono", className: "w-10 shrink-0", as: "div" }, ["On"]),
				h.div([h.Class("w-7 shrink-0")], []),
			]),
			...Arr.map(rules, (rule, index) => ruleRow(h, model, canManage, rule, index, rules.length)),
		],
	)

const rulesEmpty = (h: H, canManage: boolean): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "FilterIcon", { size: 16 })]),
				emptyTitle(h, ["No ingest rules yet"]),
				emptyDescription(h, [
					"Drop noisy records or redact sensitive values before Maple stores them. Dropped data is not billed.",
				]),
			]),
			emptyActions(
				h,
				Arr.map(TEMPLATE_IDS, (id) =>
					ruleLink(h, canManage, { variant: "outline", href: newRuleHref(id) }, [
						TEMPLATES[id].label,
					]),
				),
			),
		],
		"py-10",
	)

const rulesSkeleton = (h: H): Html =>
	skeletonList(h, {
		rows: 2,
		className: "px-4",
		renderRow: () =>
			hstack(h, { gap: "4", align: "center", className: "py-3" }, [
				h.div([h.Class("flex-1 space-y-2")], [skeleton(h, "h-4 w-40"), skeleton(h, "h-3.5 w-64")]),
				skeletonSwitch(h),
			]),
	})

export const ingestRulesSection = (h: H, model: Model, canManage: boolean): Html =>
	settingsSection(
		h,
		{
			id: "ingestion-rules-heading",
			title: "Ingest rules",
			description: [
				"Drop or redact telemetry before it is stored or billed. Applies to new data only.",
			],
			padded: false,
			actions: addRuleButton(h, canManage),
		},
		[
			h.div(
				[],
				[
					AsyncData.matchData(model.rules, {
						onEmpty: () => rulesSkeleton(h),
						onFailure: (error) =>
							errorState(h, {
								failure: error,
								title: "Couldn't load ingest rules",
								onRetry: lift(RulesMessage.ClickedRetry()),
								className: "border-0",
							}),
						onData: (rules) =>
							rules.length === 0
								? rulesEmpty(h, canManage)
								: rulesTable(h, model, canManage, rules),
					}),
					...ruleSuggestions(h, model, (inner, options, children) =>
						ruleLink(inner, canManage, options, children),
					),
				],
			),
		],
	)

export const deleteRuleDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "ingest-rule-delete-dialog",
		model: model.deleteDialog,
		toParentMessage: (message) => lift(RulesMessage.GotDeleteDialogMessage({ message })),
		title: "Delete ingest rule?",
		description: [
			"Are you sure you want to delete",
			" ",
			typography(h, { tone: "foreground", weight: "medium" }, [model.deleting?.name ?? ""]),
			"? Data already stored is unchanged.",
		],
		confirmLabel: "Delete rule",
		onConfirm: lift(RulesMessage.ClickedConfirmDelete()),
		isPending: model.isDeleting,
	})
