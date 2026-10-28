import { fromV2IngestRuleAction, type V2IngestRule } from "@maple/domain/http/v2"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { miniBars } from "../../../ui/mini-bars"
import * as Menu from "../../../ui/menu"
import type * as MenuView from "../../../ui/menu-view"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { switchControl } from "../../../ui/switch"
import { truncatedText } from "../../../ui/truncated-text"
import { emptyActions } from "../../kit/signal-empty-state"
import { newRuleHref } from "../ingest-rule/hrefs"
import { SIGNAL_LABELS, summaryParts } from "../ingest-rule/summary"
import { TEMPLATE_IDS, TEMPLATES } from "../ingest-rule/templates"
import { settingsSection } from "../kit/section"
import { hourlyMatches, menuIdOf, Message as RulesMessage, type Model } from "./ingest-rules"
import { Message } from "./message"

// `IngestRulesSection`: above the attribute mappings on the ingestion tab.

const lift = (message: RulesMessage): Message => Message.GotIngestRulesMessage({ message })

type H = HtmlBuilder<Message>

const ACTION_BADGE = {
	drop: { label: "Drop", variant: "warn" },
	redact: { label: "Redact", variant: "info" },
} as const

const addRuleButton = (h: H) =>
	linkButton(h, { size: "sm", href: newRuleHref() }, [
		icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
		"Add rule",
	])

const summary = (h: H, rule: V2IngestRule): Html =>
	h.span(
		[h.Class("text-muted-foreground min-w-0 text-xs break-words")],
		summaryParts({ conditions: rule.conditions, action: fromV2IngestRuleAction(rule.action) }).map(
			(part) =>
				part._tag === "code"
					? inlineCode(h, { variant: "plain", className: "text-foreground break-all" }, [part.text])
					: part.text,
		),
	)

const rowEntries = (index: number, count: number): ReadonlyArray<MenuView.MenuEntry> => {
	const up: MenuView.MenuEntry = { _tag: "Item", value: "up", label: "Move up", icon: "ArrowUpIcon" }
	const down: MenuView.MenuEntry = {
		_tag: "Item",
		value: "down",
		label: "Move down",
		icon: "ArrowDownIcon",
	}
	return [
		{ _tag: "Item", value: "edit", label: "Edit rule", icon: "PencilIcon" },
		...(index > 0 ? [up] : []),
		...(index < count - 1 ? [down] : []),
		{ _tag: "Item", value: "delete", label: "Delete rule", icon: "TrashIcon", variant: "destructive" },
	]
}

const muted = (h: H, text: string): Html => h.span([h.Class("text-muted-foreground text-xs")], [text])

/** Last 24h: dropped or redacted count and hourly matches; `-` when the stats did not load. */
const hitsCell = (h: H, model: Model, rule: V2IngestRule): Html => {
	const content = AsyncData.matchData(model.stats, {
		onEmpty: () => [skeleton(h, "h-3.5 w-16")],
		onFailure: () => [muted(h, "-")],
		onData: (stats) => {
			const totals = stats.rules.find((entry) => entry.id === rule.id)
			if (totals === undefined || totals.matched === 0) return [muted(h, "No hits")]
			const count =
				rule.action.type === "drop"
					? `${formatNumber(totals.dropped)} dropped`
					: `${formatNumber(totals.redacted_values)} redacted`
			return [
				h.span([h.Class("text-xs tabular-nums")], [count]),
				miniBars(h, {
					values: hourlyMatches(stats, rule.id),
					className: "text-muted-foreground h-3 w-full",
					label: `${rule.name} matches per hour`,
				}),
			]
		},
	})
	return h.div([h.Class("hidden w-28 shrink-0 flex-col gap-1 sm:flex")], content)
}

const ruleRow = (
	h: H,
	model: Model,
	isAdmin: boolean,
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
					"hover:bg-muted/20 flex items-center gap-3 border-t px-4 py-2.5 transition-colors",
					!rule.enabled && "text-muted-foreground",
				),
			),
		],
		[
			h.div(
				[h.Class("flex w-28 shrink-0 flex-col gap-1 md:w-40")],
				[
					truncatedText(h, { text: rule.name, className: "text-sm" }),
					h.span(
						[h.Class("text-muted-foreground text-2xs")],
						[rule.signals.map((signal) => SIGNAL_LABELS[signal]).join(", ")],
					),
				],
			),
			h.div(
				[h.Class("w-16 shrink-0")],
				[badge(h, { variant: action.variant, size: "sm" }, [action.label])],
			),
			h.div([h.Class("flex min-w-0 flex-1")], [summary(h, rule)]),
			hitsCell(h, model, rule),
			h.div(
				[h.Class("flex w-10 shrink-0 items-center")],
				isAdmin
					? switchControl(h, {
							id: `${menuId}-switch`,
							inputId: `${menuId}-switch-input`,
							isChecked: rule.enabled,
							isDisabled: model.pending.includes(rule.id),
							ariaLabel: `${rule.enabled ? "Turn off" : "Turn on"} ${rule.name}`,
							onToggle: lift(RulesMessage.Toggled({ id: rule.id })),
						})
					: [h.span([h.Class("text-xs")], [rule.enabled ? "On" : "Off"])],
			),
			...(isAdmin
				? [
						h.div(
							[h.Class("flex w-7 shrink-0 justify-end")],
							[
								rowActionsMenu(h, {
									slotId: menuId,
									model: model.menus[menuId] ?? Menu.init(menuId),
									entries: rowEntries(index, count),
									label: `Actions for ${rule.name}`,
									toParentMessage: (message) =>
										lift(RulesMessage.GotRowMenuMessage({ menuId, message })),
								}),
							],
						),
					]
				: []),
		],
	)
}

const rulesTable = (h: H, model: Model, isAdmin: boolean, rules: ReadonlyArray<V2IngestRule>): Html =>
	h.div(
		[],
		[
			h.div(
				[h.Class("flex items-center gap-3 px-4 py-1.5")],
				[
					eyebrow(h, { variant: "mono", className: "w-28 shrink-0 md:w-40", as: "div" }, ["Name"]),
					eyebrow(h, { variant: "mono", className: "w-16 shrink-0", as: "div" }, ["Action"]),
					eyebrow(h, { variant: "mono", className: "min-w-0 flex-1", as: "div" }, ["Rule"]),
					eyebrow(h, { variant: "mono", className: "hidden w-28 shrink-0 sm:block", as: "div" }, [
						"Last 24h",
					]),
					eyebrow(h, { variant: "mono", className: "w-10 shrink-0", as: "div" }, ["On"]),
					...(isAdmin ? [h.div([h.Class("w-7 shrink-0")], [])] : []),
				],
			),
			...rules.map((rule, index) => ruleRow(h, model, isAdmin, rule, index, rules.length)),
		],
	)

const rulesEmpty = (h: H, isAdmin: boolean): Html =>
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
			...(isAdmin
				? [
						emptyActions(
							h,
							TEMPLATE_IDS.map((id) =>
								linkButton(h, { variant: "outline", size: "sm", href: newRuleHref(id) }, [
									TEMPLATES[id].label,
								]),
							),
						),
					]
				: []),
		],
		"py-10",
	)

const rulesSkeleton = (h: H): Html =>
	skeletonList(h, {
		rows: 2,
		className: "px-4",
		renderRow: () =>
			h.div(
				[h.Class("flex items-center gap-4 py-3")],
				[
					h.div(
						[h.Class("flex-1 space-y-2")],
						[skeleton(h, "h-4 w-40"), skeleton(h, "h-3.5 w-64")],
					),
					skeleton(h, "h-5 w-9 rounded-full"),
				],
			),
	})

export const ingestRulesSection = (h: H, model: Model, isAdmin: boolean): Html =>
	settingsSection(
		h,
		{
			id: "ingestion-rules-heading",
			title: "Ingest rules",
			description: [
				"Drop or redact telemetry before it is stored or billed. Applies to new data only.",
			],
			padded: false,
			actions: isAdmin ? addRuleButton(h) : undefined,
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
								? rulesEmpty(h, isAdmin)
								: rulesTable(h, model, isAdmin, rules),
					}),
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
			h.span([h.Class("text-foreground font-medium")], [model.deleting?.name ?? ""]),
			"? Data already stored is unchanged.",
		],
		confirmLabel: "Delete",
		onConfirm: lift(RulesMessage.ClickedConfirmDelete()),
		isPending: model.isDeleting,
	})
