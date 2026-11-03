import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { AppRoute, hrefOf } from "../../route"
import type { PageViewInputs } from "../contract"
import { pageTime } from "../infra-integrations/kit/page-time"
import { analyticsFilterRail } from "../kit/analytics-filter-rail"
import { dashboardPage } from "../kit/dashboard-page"
import { linkTabStrip } from "../kit/underline-tabs"
import { populationOf, type Tab, TABS, tabOf } from "./definition"
import { Message } from "./message"
import type { Model } from "./model"
import { EVENTS_LIMIT } from "./requests"
import { DEFAULT_PRESET, withDrafts } from "./update"
import { eventsTab } from "./view-events"
import { funnelsTab } from "./view-funnels"
import { pathsTab } from "./view-paths"

// `/product-analytics`: Events, Funnels and Paths over `product_events`, beside Web analytics.

type H = HtmlBuilder<Message>

const TAB_LABEL = { events: "Events", funnels: "Funnels", paths: "Paths" } satisfies Record<Tab, string>

const tabs = (h: H, model: Model): Html => {
	const active = tabOf(model.search)
	const eventCount = Option.getOrUndefined(AsyncData.getData(model.events.data))?.length
	const shownCount =
		eventCount === undefined ? undefined : eventCount > EVENTS_LIMIT ? `${EVENTS_LIMIT}+` : eventCount
	return linkTabStrip(
		h,
		"Product analytics views",
		TABS.map((tab) => ({
			key: tab,
			href: hrefOf(
				AppRoute.ProductAnalytics({
					search: { ...withDrafts(model), tab: tab === "events" ? undefined : tab },
				}),
			),
			label: TAB_LABEL[tab],
			count: tab === "events" ? shownCount : undefined,
			isCurrent: tab === active,
			isRouteActive: tab === active,
		})),
	)
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

const rail = (h: H, model: Model): Html =>
	analyticsFilterRail(h, {
		id: "product-analytics-filters",
		breakdowns: model.breakdowns.data,
		filters: populationOf(model.search),
		showsFailureElsewhere: false,
		sections: model.filterSections,
		failedFavicons: model.failedFavicons,
		onSections: (message) => Message.GotFilterSectionsMessage({ message }),
		onToggle: (key, value) => Message.ToggledFilter({ key, value }),
		onChange: (key, value) => Message.ChangedFilter({ key, value }),
		onClear: Message.ClickedClearFilters(),
		onFaviconFailed: (host) => Message.FailedFavicon({ host }),
	})

const body = (h: H, model: Model): Html => {
	switch (tabOf(model.search)) {
		case "events":
			return eventsTab(h, model)
		case "funnels":
			return funnelsTab(h, model)
		case "paths":
			return pathsTab(h, model)
	}
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	dashboardPage(
		h,
		{
			title: "Product analytics",
			description: "What people do in your product, and where they drop off.",
			gap: "lg",
			filters: rail(h, model),
			actions: hstack(h, { gap: "2", wrap: true }, [
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
			]),
			tabs: tabs(h, model),
		},
		[body(h, model)],
	),
)
