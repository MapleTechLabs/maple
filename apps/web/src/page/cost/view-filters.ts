import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import { filterSection } from "@maple/views/ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "@maple/views/ui/filters/filter-sidebar"
import { activeFilters, type CostGroupBy, DIMENSIONS, keyLabel, unsplitDimensions } from "./derive"
import { keyDetail, keyMark } from "./marks"
import { type CostFacets, Message } from "./message"
import { sourcesOf, type Model } from "./model"

type H = HtmlBuilder<Message>

/** The rail's sections, top to bottom: who bills, then what, then where. */
const RAIL_ORDER = [
	"provider",
	"account",
	"cloud_service",
	"resource",
	"service_category",
	"region",
] as const satisfies ReadonlyArray<CostGroupBy>

/** Long lists get a search field. */
const SEARCHABLE = new Set<CostGroupBy>(["cloud_service", "resource", "region", "account"])

/**
 * The sections on show: a dimension no cost splits by is left out, unless the URL filters by it
 * (its chip must have a checkbox to clear).
 */
const railSections = (model: Model, facets: CostFacets): ReadonlyArray<CostGroupBy> => {
	const unsplit = unsplitDimensions(facets)
	return Arr.filter(
		RAIL_ORDER,
		(dimension) => !Arr.contains(unsplit, dimension) || (model.search[dimension] ?? []).length > 0,
	)
}

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const compactFormats = new Map<string, Intl.NumberFormat>()

/** A facet's cost, short enough for the rail: "$2.4K"; a plain compact number without a currency. */
const compactMoney = (currency: string) => {
	const code = /^[A-Za-z]{3}$/u.test(currency) ? currency : ""
	const cached = compactFormats.get(code)
	const format =
		cached ??
		(code === ""
			? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
			: new Intl.NumberFormat("en-US", {
					notation: "compact",
					maximumFractionDigits: 1,
					style: "currency",
					currency: code,
				}))
	compactFormats.set(code, format)
	return (amount: number) => format.format(Math.abs(amount) < 0.005 ? 0 : amount)
}

const currencyOf = (model: Model): string =>
	Option.getOrUndefined(AsyncData.getData(model.totals.data))?.currency ?? ""

const section = (h: H, model: Model, facets: CostFacets, dimension: CostGroupBy): Html => {
	const sources = sourcesOf(model)
	return filterSection(h, {
		title: DIMENSIONS[dimension].label,
		options: Arr.map(facets[dimension], (row) => ({ name: row.key, count: row.cost })),
		selected: model.search[dimension] ?? [],
		isSearchable: SEARCHABLE.has(dimension),
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (value) => Message.ToggledFacetValue({ dimension, value }),
		onOnly: (value) => Message.ClickedOnlyFacetValue({ dimension, value }),
		getOptionLabel: (value) => keyLabel(dimension, value, sources),
		getOptionDescription: (value) => {
			const detail = keyDetail(dimension, value, sources)
			const label = keyLabel(dimension, value, sources)
			return detail === null ? label : `${label} · ${detail}`
		},
		renderOptionIcon: (value) => {
			const mark = keyMark(dimension, value, sources)
			return mark === null
				? undefined
				: icon(h, mark.icon, { className: cn("size-3.5 shrink-0", mark.className) })
		},
		formatCount: compactMoney(currencyOf(model)),
	})
}

/** The cost filter rail: one checkbox section per dimension, each value with its logo and cost. */
export const filtersRail = (h: H, model: Model): Html =>
	AsyncData.matchData(model.facets.data, {
		onEmpty: () => filterSidebarLoading(h, RAIL_ORDER.length),
		onFailure: (failure) => filterSidebarError(h, failure, Message.ClickedRetry()),
		onData: (facets) =>
			filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.facets.data) }, [
				filterSidebarHeader(
					h,
					activeFilters(model.search).length > 0 ? { onClear: Message.ClickedClearFilters() } : {},
				),
				...filterSidebarBody(
					h,
					"cost-filters",
					Arr.map(railSections(model, facets), (dimension) => section(h, model, facets, dimension)),
				),
			]),
	})
