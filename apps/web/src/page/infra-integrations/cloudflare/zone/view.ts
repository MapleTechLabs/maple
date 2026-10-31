import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { ResolveThemeColors, type ThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { linkButton } from "../../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { segmentedSelect } from "../../../../ui/segmented-select"
import { skeleton } from "../../../../ui/skeleton"
import { statusDot } from "../../../../ui/status-dot"
import * as Tooltip from "../../../../ui/tooltip"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { docsLink, emptyActions } from "../../../kit/signal-empty-state"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHeroParts } from "../../../infra/kit/page-parts"
import { pageTime } from "../../kit/page-time"
import type { ZoneDetail } from "../data"
import { ingestEmpty, ingestPhaseOf } from "../ingest"
import { dataOf } from "../list/derive"
import {
	dimensionOf,
	dnsSummaryOf,
	filtersOf,
	firewallEventsOf,
	sectionOf,
	serviceNameOf,
	severityOf,
	tabsOf,
	zoneAccountOf,
	zoneRowOf,
} from "./derive"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { breakdownPanel, breakdownReason } from "./view-breakdown"
import { filterChips, filterPopover } from "./view-filters"
import { zoneRail } from "./view-rail"
import { panelScopeExplanation, type Trigger } from "./view-scope"
import {
	DNS_REASON,
	dnsSection,
	SCOPE_IDS,
	type SectionContext,
	SECURITY_REASON,
	securitySection,
} from "./view-sections"
import { zoneSignals } from "./view-strips"

// `ZoneDetailPage`.

type H = HtmlBuilder<Message>
type Context = Readonly<{ theme: ThemeColors; timeZone: string }>

/** The stacked charts name `--chart-2` and the colour-mixed severities too. */
const THEME_TOKENS = [...INFRA_CHART_TOKENS, "--chart-2", "--severity-fatal", "--primary"]

/** The lab's frame: no time controls and no filter chips. */
export type ZonePageOptions = Readonly<{ isTimed?: boolean; hasFilters?: boolean }>

type HeaderParts = Readonly<{ title: Html; actions: ReadonlyArray<Html>; body: Html }>

const header = (h: H, model: Model, hasFilters: boolean): HeaderParts => {
	const tabs = tabsOf(model)
	const tab = model.search.tab ?? "traffic"
	const severity = severityOf(model)
	const account = zoneAccountOf(model)
	const filters = filtersOf(model)
	const accountChip =
		account === null
			? []
			: account.multi
				? [
						h.a(
							[h.Href(hrefOf(AppRoute.InfraCloudflare({ search: { account: account.id } })))],
							[heroChip(h, ["account ", account.name])],
						),
					]
				: [heroChip(h, ["account ", account.name])]
	const chips = filterChips(h, model, filters)
	const hero = pageHeroParts(h, {
		title: h.span(
			[h.Class("flex items-center gap-3")],
			[...(severity === null ? [] : [statusDot(h, { tone: severity, size: "lg" })]), model.zoneName],
		),
		meta: [
			heroChip(h, "zone"),
			...accountChip,
			...(!hasFilters || chips === null ? [] : [chips]),
			...(hasFilters ? [filterPopover(h, model, filters)] : []),
		],
	})
	const actions =
		tabs.length > 1
			? [
					segmentedSelect(h, {
						size: "xs",
						ariaLabel: "Zone view",
						options: tabs,
						value: tabs.some((t) => t.value === tab) ? tab : "traffic",
						onChange: (next) => Message.ClickedTab({ tab: next }),
					}),
				]
			: []
	return { title: hero.title, actions, body: hero.body }
}

const zoneEmpty = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CloudflareBrandIcon", { size: 16 })]),
				emptyTitle(h, ["No traffic for this zone in the selected window"]),
				emptyDescription(h, [
					"Widen the time range, clear the filters, or check the zone list for where traffic is landing.",
				]),
			]),
			emptyActions(h, [
				linkButton(
					h,
					{
						variant: "outline",
						size: "sm",
						href: hrefOf(AppRoute.InfraCloudflare({ search: {} })),
					},
					["Back to zones"],
				),
				docsLink(h, "cloudflare"),
			]),
		],
		"py-16",
	)

const trafficLoading = (h: H): Html =>
	h.div([h.Class("space-y-6")], [skeleton(h, "h-80 w-full"), skeleton(h, "h-64 w-full")])

const traffic = (h: H, model: Model, ctx: Context, trigger: Trigger): Html => {
	const loaded = (detail: ZoneDetail, isWaiting: boolean): Html => {
		if (detail.statusBuckets.length === 0 && !isWaiting) {
			// Before any data is collected, "this zone has no traffic" would be the wrong thing to say.
			const phase = ingestPhaseOf(dataOf(model.status.data), dataOf(model.usage.data), model.nowMs)
			if (phase !== null && phase.kind !== "live" && phase.kind !== "backfilling")
				return ingestEmpty(h, phase)
			return zoneEmpty(h)
		}
		return h.div(
			[h.Class("space-y-6")],
			[
				zoneSignals(h, model, {
					detail,
					zoneRow: zoneRowOf(model),
					isWaiting,
					theme: ctx.theme,
					timeZone: ctx.timeZone,
				}),
				breakdownPanel(h, model, {
					filters: filtersOf(model),
					startTime: model.window?.startTime ?? "",
					timeZone: ctx.timeZone,
					trigger,
				}),
			],
		)
	}
	return AsyncData.match(model.detail.data, {
		onIdle: () => trafficLoading(h),
		onLoading: () => trafficLoading(h),
		onFailure: (failure) => errorState(h, { failure }),
		onStale: ({ error }) => errorState(h, { failure: error }),
		onSuccess: (detail) => loaded(detail, false),
		onRefreshing: (detail) => loaded(detail, true),
	})
}

const section = (h: H, model: Model, ctx: Context | null, trigger: Trigger): Html | null => {
	if (ctx === null) return trafficLoading(h)
	const sectionCtx: SectionContext = {
		filters: filtersOf(model),
		theme: ctx.theme,
		timeZone: ctx.timeZone,
		trigger,
	}
	switch (sectionOf(model)) {
		case "dns": {
			const dns = dataOf(model.dns.data)
			return dns === null
				? null
				: dnsSection(h, model, dns, AsyncData.isRefreshing(model.dns.data), sectionCtx)
		}
		case "security": {
			const security = dataOf(model.security.data)
			return security === null
				? null
				: securitySection(h, model, security, AsyncData.isRefreshing(model.security.data), sectionCtx)
		}
		case "traffic":
			return traffic(h, model, ctx, trigger)
	}
}

/** The scope chips' explanations, by trigger id. */
const tooltipContent = (model: Model, id: string): ReadonlyArray<string> => {
	if (id === SCOPE_IDS.dns)
		return panelScopeExplanation({
			ignoredFilters: dataOf(model.dns.data)?.ignoredFilters,
			reason: DNS_REASON,
		})
	if (id === SCOPE_IDS.security)
		return panelScopeExplanation({
			ignoredFilters: dataOf(model.security.data)?.ignoredFilters,
			reason: SECURITY_REASON,
		})
	if (id === SCOPE_IDS.breakdown)
		return panelScopeExplanation({
			ignoredFilters: AsyncData.isSuccess(model.breakdown.data)
				? model.breakdown.data.data.ignoredFilters
				: undefined,
			reason: breakdownReason(dimensionOf(model)),
		})
	return []
}

/** `ZoneDetailPage` below the top bar. */
export const zonePage = (h: H, model: Model, timeZone: string, options: ZonePageOptions = {}): Html => {
	const theme = model.themeColors
	const ctx = theme === null || model.chartRuntime._tag === "Loading" ? null : { theme, timeZone }
	const account = zoneAccountOf(model)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			h.submodel({
				slotId: "cloudflare-zone-tooltip",
				model: model.tooltip,
				view: Tooltip.view,
				toParentMessage: (message: Tooltip.Message) => Message.GotTooltipMessage({ message }),
				viewInputs: {
					triggerIds: Object.values(SCOPE_IDS),
					toContent: (id) => tooltipContent(model, id),
					// `ScopeChip`'s `TooltipContent className="max-w-[32ch]"`.
					className: "max-w-[32ch]",
					toView: ({ trigger, portal }) => {
						const body = section(h, model, ctx, (id) => trigger(id))
						const hero = header(h, model, options.hasFilters !== false)
						const timeControls =
							options.isTimed === false
								? []
								: [
										pageTime(h, {
											search: model.search,
											defaultPreset: DEFAULT_PRESET,
											window: model.window,
											picker: model.timePicker,
											toPickerMessage: (message) =>
												Message.GotTimePickerMessage({ message }),
											onReset: Message.ClickedResetTimeRange(),
											onReload: Message.ClickedReload(),
											isReloading: model.isReloading,
										}),
									]
						const headerActions = [...hero.actions, ...timeControls]
						return dashboardPage(
							h,
							{
								gap: "lg",
								titleContent: hero.title,
								actions:
									headerActions.length === 0
										? undefined
										: h.div(
												[h.Class("flex flex-wrap items-center gap-2")],
												headerActions,
											),
								rightPanel: zoneRail(h, model, {
									serviceName: serviceNameOf(model),
									accountName: account?.name ?? null,
									zoneRow: zoneRowOf(model),
									dns: dnsSummaryOf(model),
									firewallEvents: firewallEventsOf(model),
								}),
							},
							[
								hero.body,
								...(account === null || account.zoneError === null || account.zoneError === ""
									? []
									: [
											h.div(
												[
													h.Class(
														"rounded-md bg-severity-error-a2 px-3 py-2 text-xs text-foreground",
													),
												],
												[
													"This zone isn't syncing (",
													account.zoneError,
													"). The strips stop at its last sync; the gap is missing data, not quiet traffic.",
												],
											),
										]),
								...(body === null ? [] : [body]),
								...(portal === null ? [] : [portal]),
							],
						)
					},
				},
			}),
		],
	)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	zonePage(h, model, inputs.context.timeZone),
)
