import type { V2AttributeMapping, V2Recommendation } from "@maple/domain/http/v2"
import { formatNumber } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyMessage, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import * as Menu from "../../../ui/menu"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { switchControl } from "../../../ui/switch"
import { truncatedText } from "../../../ui/truncated-text"
import { docsLink, emptyActions } from "../../kit/signal-empty-state"
import { settingsSection } from "../kit/section"
import { Message } from "./message"
import type { Model, RecommendationTab } from "./model"

// `RecommendedMappingsSection` and `AttributeMappingsSection`.

type H = HtmlBuilder<Message>

const KIND_TAG = {
	rename: { label: "Rename", className: TONE_TEXT.info },
	"double-emission": { label: "Duplicate", className: TONE_TEXT.warn },
	naming: { label: "Naming", className: TONE_TEXT.warn },
} as const
const STATUS_BADGE = {
	open: { label: "Open", variant: "secondary" },
	dismissed: { label: "Dismissed", variant: "secondary" },
	applied: { label: "Applied", variant: "ok" },
	resolved: { label: "Resolved", variant: "done" },
} as const

const code = (h: H, text: string) => inlineCode(h, { variant: "plain" }, [text])
const strong = (h: H, text: string) => h.span([h.Class("text-foreground font-medium")], [text])
const muted = (h: H, text: string) => h.span([h.Class("text-muted-foreground")], [text])

const sentence = (h: H, issue: V2Recommendation): ReadonlyArray<Html | string> => {
	if (issue.kind === "double-emission")
		return [
			strong(h, "Standardize on"),
			" ",
			code(h, issue.canonical_key ?? ""),
			muted(h, "; spans also emit "),
			code(h, issue.source_key),
		]
	if (issue.kind === "naming")
		return [strong(h, "Rename non-conforming key"), " ", code(h, issue.source_key)]
	return [
		strong(h, "Rename"),
		" ",
		code(h, issue.source_key),
		" ",
		muted(h, "→"),
		" ",
		code(h, issue.canonical_key ?? ""),
	]
}

const recommendationActions = (h: H, model: Model, issue: V2Recommendation): ReadonlyArray<Html> => {
	const isPending = model.pendingRecommendations.includes(issue.id)
	const status = STATUS_BADGE[issue.status]
	const href = `/recommendations/${encodeURIComponent(issue.id)}`
	if (issue.status === "dismissed")
		return [
			badge(h, { variant: status.variant }, [status.label]),
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					isLoading: isPending,
					attributes: [h.OnClick(Message.ClickedReopenRecommendation({ id: issue.id }))],
				},
				[icon(h, "ArrowRotateAnticlockwiseIcon"), "Reopen"],
			),
		]
	if (issue.status !== "open") return [badge(h, { variant: status.variant }, [status.label])]
	const primary =
		issue.kind === "rename"
			? model.isAdmin
				? [
						button(
							h,
							{
								size: "sm",
								isLoading: isPending,
								attributes: [h.OnClick(Message.ClickedApplyRecommendation({ id: issue.id }))],
							},
							[icon(h, "CheckIcon"), "Apply fix"],
						),
					]
				: []
			: [linkButton(h, { variant: "outline", size: "sm", href }, [icon(h, "CodeIcon"), "How to fix"])]
	return [
		...primary,
		button(
			h,
			{
				variant: "ghost",
				size: "sm",
				className: "text-muted-foreground hover:text-foreground",
				isLoading: isPending,
				attributes: [h.OnClick(Message.ClickedDismissRecommendation({ id: issue.id }))],
			},
			["Dismiss"],
		),
	]
}

const recommendationRow = (h: H, model: Model, issue: V2Recommendation): Html => {
	const kind = KIND_TAG[issue.kind]
	return h.div(
		[h.Key(issue.id), h.Class("hover:bg-muted/50 flex items-start gap-3 px-4 py-3 transition-colors")],
		[
			eyebrow(h, { variant: "mono", className: cn("w-20 shrink-0 pt-0.5", kind.className) }, [
				kind.label,
			]),
			h.div(
				[h.Class("min-w-0 flex-1 space-y-1")],
				[
					h.a(
						[
							h.Href(`/recommendations/${encodeURIComponent(issue.id)}`),
							h.Class(
								"block text-sm break-words underline-offset-4 decoration-muted-foreground/40 hover:underline",
							),
						],
						sentence(h, issue),
					),
					h.p(
						[h.Class("text-muted-foreground text-2xs")],
						[
							formatNumber(issue.usage_count),
							" spans in 24h ·",
							" ",
							issue.kind === "rename"
								? "fixed at ingest, no code change"
								: "needs a code change",
						],
					),
				],
			),
			h.div([h.Class("flex shrink-0 items-center gap-1.5")], recommendationActions(h, model, issue)),
		],
	)
}

const RECOMMENDATIONS_DESCRIPTION =
	"Deprecated or non-conforming attribute keys found on your spans in the last 24 hours."

export const recommendationsSection = (h: H, model: Model): ReadonlyArray<Html> => {
	// `/recommendations` lands here, so a failed read still names the section rather than hiding it.
	if (AsyncData.isFailure(model.recommendations))
		return [
			settingsSection(
				h,
				{
					id: "ingestion-recommendations-heading",
					title: "Recommendations",
					description: [RECOMMENDATIONS_DESCRIPTION],
					framed: false,
				},
				[
					errorState(h, {
						variant: "row",
						failure: model.recommendations.error,
						title: "Couldn't check for recommendations",
					}),
				],
			),
		]
	if (!AsyncData.isSuccess(model.recommendations) && !AsyncData.isRefreshing(model.recommendations))
		return []
	const issues = AsyncData.getOrElse(model.recommendations, () => [])
	if (!issues.some((issue) => issue.status === "open" || issue.status === "dismissed")) return []
	const open = issues.filter((issue) => issue.status === "open")
	const closed = issues.filter((issue) => issue.status !== "open")
	const rows = model.recommendationTab === "open" ? open : closed
	return [
		settingsSection(
			h,
			{
				id: "ingestion-recommendations-heading",
				title: "Recommendations",
				description: [RECOMMENDATIONS_DESCRIPTION],
				padded: false,
				actions: segmentedSelect<RecommendationTab, Message>(h, {
					size: "sm",
					ariaLabel: "Recommendation status",
					value: model.recommendationTab,
					onChange: (tab) => Message.ClickedRecommendationTab({ tab }),
					options: [
						{ value: "open", label: `Open · ${open.length}` },
						{ value: "closed", label: `Closed · ${closed.length}` },
					],
				}),
			},
			[
				rows.length === 0
					? emptyMessage(h, { className: "flex flex-col items-center gap-2 text-sm" }, [
							h.p(
								[],
								[
									model.recommendationTab === "open"
										? "No open recommendations. Your span attributes look healthy."
										: "Applied and dismissed recommendations show up here.",
								],
							),
							...(model.recommendationTab === "open" ? [docsLink(h, "otelConventions")] : []),
						])
					: h.div(
							[h.Class("divide-y")],
							rows.map((issue) => recommendationRow(h, model, issue)),
						),
			],
		),
	]
}

// MAPPINGS

const OPERATION_BADGE = { copy: "info", move: "warn" } as const
const OPERATION_LABELS = { copy: "Copy", move: "Move" } as const
const APPLIES_TO = { span: "Span attributes", resource: "Resource attributes" } as const

const addMappingButton = (h: H) =>
	button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedAddMapping())] }, [
		icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
		"Add mapping",
	])

const mappingRow = (h: H, model: Model, mapping: V2AttributeMapping): Html => {
	const menuId = `mapping-row-${mapping.id}`
	return h.div(
		[
			h.Key(mapping.id),
			h.Class(
				cn(
					"hover:bg-muted/50 flex items-center gap-3 border-t px-4 py-2.5 transition-colors",
					!mapping.enabled && "text-muted-foreground",
				),
			),
		],
		[
			truncatedText(h, { text: mapping.name, className: "w-28 shrink-0 text-sm md:w-40" }),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm")],
				[
					badge(h, { variant: OPERATION_BADGE[mapping.operation], size: "sm" }, [
						OPERATION_LABELS[mapping.operation],
					]),
					inlineCode(
						h,
						{ variant: "plain", className: "text-muted-foreground min-w-0 break-all" },
						[mapping.source_key],
					),
					icon(h, "ArrowRightIcon", { size: 12, className: "text-muted-foreground shrink-0" }),
					inlineCode(h, { variant: "plain", className: "text-foreground min-w-0 break-all" }, [
						mapping.target_key,
					]),
				],
			),
			h.span(
				[h.Class("text-muted-foreground hidden w-36 shrink-0 text-xs md:block")],
				[APPLIES_TO[mapping.source_context]],
			),
			h.div(
				[h.Class("flex w-10 shrink-0 items-center")],
				model.isAdmin
					? switchControl(h, {
							id: `${menuId}-switch`,
							inputId: `${menuId}-switch-input`,
							isChecked: mapping.enabled,
							isDisabled: model.pendingToggles.includes(mapping.id),
							ariaLabel: `${mapping.enabled ? "Turn off" : "Turn on"} ${mapping.name}`,
							onToggle: Message.ToggledMapping({ id: mapping.id }),
						})
					: [h.span([h.Class("text-xs")], [mapping.enabled ? "On" : "Off"])],
			),
			...(model.isAdmin
				? [
						h.div(
							[h.Class("flex w-7 shrink-0 justify-end")],
							[
								rowActionsMenu(h, {
									slotId: menuId,
									model: model.rowMenus[menuId] ?? Menu.init(menuId),
									entries: [
										{
											_tag: "Item",
											value: "edit",
											label: "Edit mapping",
											icon: "PencilIcon",
										},
										{
											_tag: "Item",
											value: "delete",
											label: "Delete mapping",
											icon: "TrashIcon",
											variant: "destructive",
										},
									],
									label: `Actions for ${mapping.name}`,
									toParentMessage: (message) =>
										Message.GotRowMenuMessage({ menuId, message }),
								}),
							],
						),
					]
				: []),
		],
	)
}

const mappingsTable = (h: H, model: Model, mappings: ReadonlyArray<V2AttributeMapping>): Html =>
	h.div(
		[],
		[
			h.div(
				[h.Class("flex items-center gap-3 px-4 py-1.5")],
				[
					eyebrow(h, { variant: "mono", className: "w-28 shrink-0 md:w-40", as: "div" }, ["Name"]),
					eyebrow(h, { variant: "mono", className: "min-w-0 flex-1", as: "div" }, ["Rule"]),
					eyebrow(h, { variant: "mono", className: "hidden w-36 shrink-0 md:block", as: "div" }, [
						"Applies to",
					]),
					eyebrow(h, { variant: "mono", className: "w-10 shrink-0", as: "div" }, ["On"]),
					...(model.isAdmin ? [h.div([h.Class("w-7 shrink-0")], [])] : []),
				],
			),
			...mappings.map((mapping) => mappingRow(h, model, mapping)),
		],
	)

const mappingsEmpty = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "ArrowUpDownIcon", { size: 16 })]),
				emptyTitle(h, ["No attribute mappings yet"]),
				emptyDescription(h, [
					"Mappings rename span attribute keys that do not follow OpenTelemetry names, so dashboards and alerts find them. Rules apply to new spans only.",
				]),
			]),
			emptyActions(h, [
				...(model.isAdmin ? [addMappingButton(h)] : []),
				docsLink(h, "otelConventions"),
			]),
		],
		"py-10",
	)

const mappingsSkeleton = (h: H): Html =>
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

export const mappingsSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "ingestion-mappings-heading",
			title: "Attribute mappings",
			description: ["Copy or move attribute keys as data arrives. Applies to new data only."],
			padded: false,
			actions: model.isAdmin ? addMappingButton(h) : undefined,
		},
		[
			h.div(
				[],
				[
					AsyncData.matchData(model.mappings, {
						onEmpty: () => mappingsSkeleton(h),
						onFailure: (error) =>
							errorState(h, {
								failure: error,
								title: "Couldn't load mappings",
								onRetry: Message.ClickedRetryMappings(),
								className: "border-0",
							}),
						onData: (mappings) =>
							mappings.length === 0
								? mappingsEmpty(h, model)
								: mappingsTable(h, model, mappings),
					}),
				],
			),
		],
	)

export const deleteMappingDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "mapping-delete-dialog",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: "Delete attribute mapping?",
		description: [
			"Are you sure you want to delete",
			" ",
			h.span([h.Class("text-foreground font-medium")], [model.deleting?.name ?? ""]),
			"? This action cannot be undone.",
		],
		confirmLabel: "Delete",
		onConfirm: Message.ClickedConfirmDelete(),
		isPending: model.isDeleting,
	})
