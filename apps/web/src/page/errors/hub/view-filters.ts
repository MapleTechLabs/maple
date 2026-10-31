import type { IssueKind } from "@maple/domain/http"
import { getServiceColor } from "@maple/ui/lib/colors"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { filterSection, singleCheckboxFilter } from "../../../ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../ui/filters/filter-sidebar"
import { SOURCE_COLOR, SOURCE_DESCRIPTION, SOURCES } from "../kit/source"
import { Option } from "effect"
import { failureKind } from "../../../ui/error-state"
import { hasErrorFilters, KIND_LABEL, listFailureOf } from "./derive"
import { MountFilterRail } from "./command"
import { type FilterParam, Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const isIssueKind = (value: string): value is IssueKind => SOURCES.some((kind) => kind === value)

const section = (
	h: H,
	model: Model,
	title: string,
	param: FilterParam,
	options: ReadonlyArray<{ name: string; count: number }>,
	selected: string | undefined,
	extra: Partial<Parameters<typeof filterSection<Message>>[1]> = {},
) =>
	filterSection(h, {
		title,
		options,
		selected: selected === undefined ? [] : [selected],
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFilterOption({ param, name }),
		...extra,
	})

/** `ErrorsFilterSidebar`; its Mount asks for the counts once the rail is actually rendered. */
export const filtersRail = (h: H, model: Model): Html =>
	h.div([h.Class("contents"), h.OnMount(MountFilterRail())], [railContent(h, model)])

/** The service counts are what the sidebar is mostly made of: it waits for them. */
const railContent = (h: H, model: Model): Html => {
	const { search } = model
	const counts = model.serviceCounts.data
	if (!AsyncData.hasData(counts) && !AsyncData.isFailure(counts)) return filterSidebarLoading(h, 3)
	// A failed list steps the rail aside like the other list pages, unless changing a filter is the fix.
	const listFailure = Option.getOrUndefined(listFailureOf(model))
	const countsFailure = Option.getOrUndefined(AsyncData.getError(counts))
	const railFailure =
		countsFailure ??
		(listFailure !== undefined && failureKind(listFailure) !== "fixable" ? listFailure : undefined)
	if (railFailure !== undefined)
		return filterSidebarError(h, railFailure, Message.ClickedReload(), listFailure)
	const services = AsyncData.getOrElse(counts, () => []).map((row) => ({
		name: row.service_name,
		count: row.open_count,
	}))
	if (AsyncData.hasData(counts) && services.length === 0 && !hasErrorFilters(search))
		return filterSidebarEmpty(h)
	const environments = AsyncData.getOrElse(model.environments.data, () => []).map((name) => ({
		name,
		count: 0,
	}))
	const hasFilters = hasErrorFilters(search)
	return filterSidebarFrame(h, { isWaiting: false }, [
		filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(
			h,
			"errors-filters",
			present([
				singleCheckboxFilter(h, {
					title: "Regressed only",
					isChecked: search.regressed === true,
					onToggle: Message.ToggledFilterOption({ param: "regressed", name: "regressed" }),
				}),
				section(h, model, "Service", "service", services, search.service, {
					// The map covers the facet's services only: a selected unknown one has no swatch.
					colorOf: (name) =>
						services.some((option) => option.name === name) ? getServiceColor(name) : undefined,
				}),
				section(h, model, "Environment", "env", environments, search.env, { showCounts: false }),
				section(
					h,
					model,
					"Source",
					"kind",
					SOURCES.map((name) => ({ name, count: 0 })),
					search.kind,
					{
						hasDescription: true,
						colorOf: (name) => (isIssueKind(name) ? SOURCE_COLOR[name] : undefined),
						getOptionDescription: (name) =>
							isIssueKind(name) ? SOURCE_DESCRIPTION[name] : undefined,
						getOptionLabel: (name) => (isIssueKind(name) ? KIND_LABEL[name] : name),
						showCounts: false,
					},
				),
			]),
		),
	])
}

const present = (nodes: ReadonlyArray<Html | null>): ReadonlyArray<Html> =>
	nodes.filter((node): node is Html => node !== null)
