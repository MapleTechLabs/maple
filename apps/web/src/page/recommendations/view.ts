import type { V2Recommendation } from "@maple/domain/http/v2"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import type { BreadcrumbEntry } from "../../shell"
import { button, linkButton } from "../../ui/button"
import { detailRailGroup, detailRailRow } from "../../ui/detail-rail"
import { badge } from "../../ui/display"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { skeleton } from "../../ui/skeleton"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { detailTitle, detailTitleSkeleton } from "../kit/detail-header"
import { relativeTime } from "../kit/relative-time"
import { resourceNotFound } from "../kit/resource-not-found"
import { selectedOf } from "./update"
import { body, code, isApplyable, isLive } from "./view-body"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const INGESTION_HREF = hrefOf(AppRoute.Settings({ search: { tab: "ingestion" } }))

const KIND_BADGE = {
	rename: { label: "Safe rename", variant: "ok" },
	"double-emission": { label: "Both emitted", variant: "warn" },
	naming: { label: "Naming", variant: "info" },
} as const

const STATUS_BADGE = {
	open: { label: "Open", variant: "outline" },
	dismissed: { label: "Dismissed", variant: "secondary" },
	applied: { label: "Applied", variant: "ok" },
	resolved: { label: "Resolved", variant: "done" },
} as const

const MODE = {
	auto: {
		label: "Auto-apply",
		icon: "BoltIcon",
		className: "border-primary-a3 text-primary",
		title: "Maple can apply this for you. Apply creates the ingest mapping.",
	},
	manual: {
		label: "Manual fix",
		icon: "CodeIcon",
		className: "text-muted-foreground",
		title: "Fix this in your SDK. An ingest mapping can't resolve it.",
	},
} as const

/** `recSentence`: the recommendation as a sentence with mono-styled keys. */
const recSentence = (h: H, issue: V2Recommendation): ReadonlyArray<Html | string> =>
	issue.kind === "double-emission"
		? [
				h.span([h.Class("text-foreground font-medium")], ["Standardize on"]),
				" ",
				code(h, issue.canonical_key),
				h.span([h.Class("text-muted-foreground")], [". Spans also emit "]),
				code(h, issue.source_key),
			]
		: issue.kind === "naming"
			? [
					h.span([h.Class("text-foreground font-medium")], ["Rename non-conforming key"]),
					" ",
					code(h, issue.source_key),
				]
			: [
					h.span([h.Class("text-foreground font-medium")], ["Rename"]),
					" ",
					code(h, issue.source_key),
					" ",
					h.span([h.Class("text-muted-foreground")], ["→"]),
					" ",
					code(h, issue.canonical_key),
				]

const recTitleText = (issue: V2Recommendation): string =>
	issue.kind === "double-emission"
		? `Standardize on ${issue.canonical_key}, spans also emit ${issue.source_key}`
		: issue.kind === "naming"
			? `Rename non-conforming key ${issue.source_key}`
			: `Rename ${issue.source_key} → ${issue.canonical_key}`

const row = (h: H, label: string, children: ReadonlyArray<Html | string>, title?: string): Html =>
	detailRailRow(h, { label, labelWidth: "64px", title }, children)

const RESOLVES = [
	"the deprecated key stops appearing on your spans",
	"an ingest mapping covers the key",
	"you apply the rename",
]

const actionGroup = (h: H, model: Model, issue: V2Recommendation): Html => {
	if (isLive(issue))
		return h.div(
			[h.Class("flex flex-col gap-3")],
			[
				h.p(
					[h.Class("flex items-center gap-2 text-sm text-severity-info")],
					[
						icon(h, "CircleCheckIcon", { size: 14 }),
						issue.status === "resolved" ? "Resolved" : "Mapping is active",
					],
				),
				linkButton(h, { variant: "outline", size: "sm", className: "w-full", href: INGESTION_HREF }, [
					"Manage mappings",
				]),
			],
		)
	if (issue.status === "dismissed")
		return h.div(
			[h.Class("flex flex-col gap-2")],
			[
				button(
					h,
					{
						variant: "outline",
						size: "sm",
						className: "w-full",
						isLoading: model.busy === "reopen",
						attributes: [h.OnClick(Message.ClickedReopen())],
					},
					[icon(h, "ArrowRotateAnticlockwiseIcon"), "Reopen recommendation"],
				),
				h.p(
					[h.Class("text-xs leading-relaxed text-muted-foreground")],
					["Dismissed recommendations come back if the key is still emitted."],
				),
			],
		)
	return h.div(
		[h.Class("flex flex-col gap-2")],
		[
			isApplyable(issue)
				? button(
						h,
						{
							className: "w-full",
							isLoading: model.busy === "apply",
							attributes: [h.OnClick(Message.ClickedApply())],
						},
						[icon(h, "BoltIcon"), "Apply mapping"],
					)
				: h.p(
						[h.Class("text-xs leading-relaxed text-muted-foreground")],
						[
							"This one is a manual fix: rename the attribute at your SDK. Maple can't apply it for you.",
						],
					),
			button(
				h,
				{
					className: "w-full",
					isLoading: model.busy === "dismiss",
					attributes: [h.OnClick(Message.ClickedDismiss())],
				},
				[icon(h, "XmarkIcon"), "Dismiss recommendation"],
			),
		],
	)
}

const sidebar = (h: H, model: Model, issue: V2Recommendation, timeZone: string): Html => {
	const kindBadge = KIND_BADGE[issue.kind]
	const mode = issue.kind === "rename" ? MODE.auto : MODE.manual
	const status = STATUS_BADGE[issue.status]
	return h.div(
		[h.Class("flex flex-col")],
		[
			detailRailGroup(h, "Details", [
				row(h, "Status", [badge(h, { variant: status.variant }, [status.label])]),
				row(h, "Type", [badge(h, { variant: kindBadge.variant }, [kindBadge.label])]),
				row(h, "Fix", [
					badge(
						h,
						{
							variant: "outline",
							className: cn("gap-1", mode.className),
							attributes: [h.Title(mode.title)],
						},
						[icon(h, mode.icon, { size: 12 }), mode.label],
					),
				]),
				row(h, "Spans", [
					h.span([h.Class("tabular-nums text-foreground")], [formatNumber(issue.usage_count)]),
				]),
				row(h, "Opened", [
					relativeTime(h, {
						value: issue.opened_at,
						nowMs: model.nowMs ?? 0,
						timeZone,
						tooltip: "title",
						className: "tabular-nums text-muted-foreground",
					}),
				]),
				row(
					h,
					"Key",
					[
						h.code(
							[h.Class("truncate font-mono text-xs text-muted-foreground")],
							[issue.source_key],
						),
					],
					issue.source_key,
				),
			]),
			detailRailGroup(h, "How this resolves", [
				h.ul(
					[h.Class("flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground")],
					RESOLVES.map((line) =>
						h.li(
							[h.Class("flex gap-2")],
							[
								h.span(
									[h.AriaHidden(true), h.Class("select-none text-foreground-faint")],
									["·"],
								),
								h.span([], [line]),
							],
						),
					),
				),
			]),
			detailRailGroup(h, "Action", [actionGroup(h, model, issue)]),
		],
	)
}

const column = { width: "narrow", gap: "lg" } as const

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	AsyncData.match(model.list.data, {
		onIdle: () => dashboardPage(h, { ...column, titleContent: detailTitleSkeleton(h) }, loadingBody(h)),
		onLoading: () => dashboardPage(h, { ...column, titleContent: detailTitleSkeleton(h) }, loadingBody(h)),
		onFailure: (failure) =>
			dashboardPage(h, column, [
				errorState(h, {
					failure,
					title: "Couldn't load recommendation",
					onRetry: Message.ClickedRetry(),
				}),
			]),
		onStale: ({ error }) =>
			dashboardPage(h, column, [
				errorState(h, {
					failure: error,
					title: "Couldn't load recommendation",
					onRetry: Message.ClickedRetry(),
				}),
			]),
		onSuccess: () => loaded(h, model, inputs.context.timeZone),
		onRefreshing: () => loaded(h, model, inputs.context.timeZone),
	}),
)

const loadingBody = (h: H) => [
	skeleton(h, "h-12 w-full"),
	skeleton(h, "h-28 w-full"),
	skeleton(h, "h-24 w-full"),
]

const loaded = (h: H, model: Model, timeZone: string): Html =>
	Option.match(selectedOf(model), {
		onNone: () =>
			dashboardPage(h, column, [
				resourceNotFound(h, {
					icon: icon(h, "PulseIcon", { className: "text-muted-foreground" }),
					title: "Recommendation not found",
					description:
						"This recommendation isn't in your list anymore. It may have resolved on its own.",
					back: { href: INGESTION_HREF, label: "Back to recommendations" },
				}),
			]),
		onSome: (issue) => {
			const status = STATUS_BADGE[issue.status]
			return dashboardPage(
				h,
				{
					...column,
					titleContent: detailTitle(h, {
						kind: ["Recommendation"],
						title: recSentence(h, issue),
						titleText: recTitleText(issue),
						meta: [badge(h, { variant: status.variant, size: "lg" }, [status.label])],
					}),
					rightPanel: sidebar(h, model, issue, timeZone),
					rightPanelWidth: "w-80",
				},
				body(h, model, issue),
			)
		},
	})

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Ingestion", href: INGESTION_HREF },
	{
		label: AsyncData.match(model.list.data, {
			onIdle: () => "Loading…",
			onLoading: () => "Loading…",
			onFailure: () => "Error",
			onStale: () => "Error",
			onSuccess: () => crumbOf(model),
			onRefreshing: () => crumbOf(model),
		}),
	},
]

const crumbOf = (model: Model) =>
	Option.match(selectedOf(model), {
		onNone: () => "Not found",
		onSome: (issue) => `Recommendation #${issue.number}`,
	})
