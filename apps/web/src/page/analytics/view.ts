import { activeFilterChips } from "../../components/analytics/filters"
import { formatNumber, pluralize } from "@maple/ui/lib/format"
import { TONE_BORDER, TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { icon } from "../../ui/icon"
import { statusDot } from "../../ui/status-dot"
import type { PageViewInputs } from "../contract"
import { pageTime } from "../infra-integrations/kit/page-time"
import { dashboardPage } from "../kit/dashboard-page"
import { signalEmptyState } from "../kit/signal-empty-state"
import { presenceOf } from "../kit/signal-presence"
import { underlineTabClass, underlineTabStrip } from "../kit/underline-tabs"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersOf, tabOf } from "./requests"
import { DEFAULT_PRESET } from "./update"
import { aiTab } from "./view-ai"
import { TRAFFIC_TOKENS } from "./view-chart"
import { expandDialog } from "./view-expand"
import { filtersRail } from "./view-filters"
import { overviewContent } from "./view-overview"

// The web analytics page.

type H = HtmlBuilder<Message>

/** `AnalyticsLiveBadge`: silent until its first poll lands, then the last number it saw. */
const liveBadge = (h: H, model: Model): ReadonlyArray<Html> => {
	const live = Option.getOrUndefined(AsyncData.getData(model.live.data))
	if (live === undefined) return []
	const isIdentified = live.visitors > 0
	const count = isIdentified ? live.visitors : live.sessions
	const minutes = Math.max(1, Math.round(live.windowSeconds / 60))
	const noun = pluralize(count, isIdentified ? "visitor" : "session")
	return [
		h.span(
			[
				h.Class(
					cn(
						"inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium tabular-nums",
						count > 0
							? cn(TONE_SOFT.ok, TONE_BORDER.ok)
							: "border-border/70 text-muted-foreground",
					),
				),
				h.Title(`${count} ${noun} active in the last ${minutes} ${pluralize(minutes, "minute")}`),
			],
			[
				count > 0 ? statusDot(h, { tone: "ok" }) : statusDot(h),
				h.span(
					[h.AriaLive("polite")],
					[formatNumber(count), " ", h.span([h.Class("hidden sm:inline")], ["online"])],
				),
			],
		),
	]
}

const replaysLink = (h: H, model: Model): Html => {
	const { search } = model
	return linkButton(
		h,
		{
			variant: "outline",
			size: "sm",
			href: hrefOf(
				AppRoute.Replays({
					search: {
						startTime: search.startTime,
						endTime: search.endTime,
						timePreset: search.timePreset,
					},
				}),
			),
			attributes: [h.AriaLabel("View session replays")],
		},
		[icon(h, "PlayRotateClockwiseIcon"), h.span([h.Class("hidden sm:inline")], ["Replays"])],
	)
}

const tabs = (h: H, model: Model): Html => {
	const active = tabOf(model.search)
	return underlineTabStrip(
		h,
		{ label: "Analytics views", navigation: true },
		(["overview", "ai"] as const).map((tab) => {
			const isCurrent = tab === active
			// TanStack's partial search match: Overview's link (no `tab`) matches every tab.
			const isLinkActive = tab === "overview" || isCurrent
			return h.a(
				[
					h.Key(tab),
					...(isCurrent ? [h.AriaCurrent("page")] : []),
					h.Class(cn(underlineTabClass(isCurrent), isLinkActive && "active")),
					...(isLinkActive ? [h.DataAttribute("status", "active")] : []),
					h.Href(
						hrefOf(
							AppRoute.Analytics({
								search: { ...model.search, tab: tab === "overview" ? undefined : tab },
							}),
						),
					),
				],
				[tab === "overview" ? "Overview" : "AI traffic"],
			)
		}),
	)
}

/** The active filters, removable one at a time. */
const chipsRow = (h: H, model: Model): ReadonlyArray<Html> => {
	const chips = activeFilterChips(filtersOf(model.search))
	if (chips.length === 0) return []
	return [
		h.div(
			[h.Class("flex flex-wrap items-center gap-1.5")],
			[
				...chips.map((chip) =>
					h.button(
						[
							h.Key(`${chip.key}:${chip.value}`),
							h.Type("button"),
							h.Class(
								cn(
									badgeVariants({
										variant: "meta",
										size: "xs",
										mono: true,
										className:
											"h-auto px-1.5 py-0.5 transition-colors hover:text-foreground",
									}),
								),
							),
							h.DataAttribute("slot", "badge"),
							h.OnClick(Message.ChangedFilter({ key: chip.key, value: undefined })),
						],
						[chip.label, " ✕"],
					),
				),
				button(
					h,
					{
						variant: "link",
						size: "xs",
						className: "h-auto px-1 text-3xs text-muted-foreground sm:text-3xs",
						attributes: [h.OnClick(Message.ClickedClearFilters())],
					},
					["Clear all"],
				),
			],
		),
	]
}

const body = (h: H, model: Model, timeZone: string, isNarrow: boolean): Html => {
	if (tabOf(model.search) === "ai") return aiTab(h, model, timeZone)
	const presence = presenceOf(model.presence, "sessions")
	if (presence.status === "absent" && activeFilterChips(filtersOf(model.search)).length === 0)
		return signalEmptyState(h, {
			signal: "sessions",
			presence,
			nowMs: model.nowMs,
			noun: "visits",
			purpose: "See your visitors, top pages and where they came from.",
			action: "Set up web analytics",
			guideDocs: "webAnalytics",
		})
	return overviewContent(h, model, timeZone, isNarrow)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: TRAFFIC_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					scrollClassName: "gap-6",
					filters: filtersRail(h, model),
					actions: h.div(
						[h.Class("flex flex-wrap items-center gap-2")],
						[
							...liveBadge(h, model),
							replaysLink(h, model),
							pageTime(h, {
								search: model.search,
								defaultPreset: DEFAULT_PRESET,
								window: model.window,
								picker: model.timePicker,
								toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
								onReset: Message.ClickedResetTimeRange(),
								onReload: Message.ClickedReload(),
								isReloading: model.isReloading,
							}),
						],
					),
					tabs: tabs(h, model),
				},
				[...chipsRow(h, model), body(h, model, timeZone, inputs.isBelowSm === true)],
			),
			expandDialog(h, model, timeZone),
		],
	)
})
