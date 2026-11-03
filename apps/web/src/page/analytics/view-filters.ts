import { activeFilterChips } from "../../components/analytics/filters"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { presenceOf } from "@maple/views/data/signal-presence"
import { analyticsFilterRail } from "../kit/analytics-filter-rail"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersOf, tabOf } from "./requests"

// The page's filter rail: the kit's, with the Traffic group and the Event section.

type H = HtmlBuilder<Message>

/** The overview's breakdown cards render (not the AI tab, not the no-sessions setup state). */
export const showsBreakdownCards = (model: Model): boolean =>
	tabOf(model.search) === "overview" &&
	!(
		presenceOf(model.presence, "sessions").status === "absent" &&
		activeFilterChips(filtersOf(model.search)).length === 0
	)

// The breakdown cards show this same read's failure in full; when they are not drawn, the rail explains it.
export const filtersRail = (h: H, model: Model): Html =>
	analyticsFilterRail(h, {
		id: "analytics-filters",
		breakdowns: model.breakdowns.data,
		filters: filtersOf(model.search),
		events: Option.getOrElse(AsyncData.getData(model.events.data), () => []).map((event) => ({
			name: event.name,
			count: event.sessions,
		})),
		showsFailureElsewhere: showsBreakdownCards(model),
		sections: model.filterSections,
		failedFavicons: model.failedFavicons,
		onSections: (message) => Message.GotFilterSectionsMessage({ message }),
		onToggle: (key, value) => Message.ToggledFilter({ key, value }),
		onChange: (key, value) => Message.ChangedFilter({ key, value }),
		traffic: { onToggle: (which, isOn) => Message.ToggledTraffic({ which, isOn }) },
		onClear: Message.ClickedClearFilters(),
		onFaviconFailed: (host) => Message.FailedFavicon({ host }),
	})
