import { getServiceColor } from "@maple/ui/lib/colors"
import { button } from "@maple/web/ui/button"
import { filterSection, singleCheckboxFilter } from "@maple/web/ui/filters/filter-section"
import type * as FilterSections from "@maple/web/ui/filters/filter-sections"
import {
	filterSidebarBody,
	filterSidebarFrame,
	filterSidebarHeader,
} from "@maple/web/ui/filters/filter-sidebar"
import { formatValue } from "@maple/web/ui/filters/range-format"
import { type RangePreset, rangeFilterSection } from "@maple/web/ui/filters/range-filter-section"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { TraceFilters } from "./filters"
import { type FacetParam, Message } from "./message"
import type { DurationStats, FacetOption, Model } from "./model"

// The filter rail of the traces list.

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

/** `DurationRangeFilter`: p50 and p95 presets from the facet stats, then "> 1s". */
const durationPresets = (maybeStats: Option.Option<DurationStats>): ReadonlyArray<RangePreset> => {
	const stats = Option.getOrNull(maybeStats)
	const p50 = Math.round(stats?.p50DurationMs ?? 0)
	const p95 = Math.round(stats?.p95DurationMs ?? 0)
	return [
		...(stats !== null && stats.p50DurationMs > 0
			? [{ key: "p50", label: "> p50", value: formatValue(p50, "ms"), min: p50 }]
			: []),
		...(stats !== null && stats.p95DurationMs > 0
			? [{ key: "p95", label: "> p95", value: formatValue(p95, "ms"), min: p95 }]
			: []),
		{ key: "1s", label: "> 1s", min: 1000 },
	]
}

/** Single-select facet: the list query takes one value per dimension. */
const facet = (
	h: HtmlBuilder<Message>,
	model: Model,
	title: string,
	param: FacetParam,
	options: ReadonlyArray<FacetOption>,
	selected: string | undefined,
	extra: Readonly<{ isSearchable?: boolean; colorOf?: (name: string) => string }> = {},
): Html | null =>
	filterSection(h, {
		title,
		options,
		selected: selected ? [selected] : [],
		isSearchable: extra.isSearchable ?? false,
		colorOf: extra.colorOf,
		sections: model.sections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFacetOption({ param, name }),
	})

const durationSection = (
	h: HtmlBuilder<Message>,
	model: Model,
	filters: TraceFilters,
	maybeStats: Option.Option<DurationStats>,
) =>
	rangeFilterSection(h, {
		title: "Duration",
		unit: "ms",
		minValue: filters.minDurationMs,
		maxValue: filters.maxDurationMs,
		draft: { min: model.duration.min, max: model.duration.max },
		presets: durationPresets(maybeStats),
		ids: { panel: "traces-duration-panel", min: "traces-duration-min", max: "traces-duration-max" },
		sections: model.sections,
		toSectionsMessage: toSections,
		onDraftChange: (min, max) => Message.ChangedDurationDraft({ min, max }),
		onCommitDraft: Message.CommittedDurationDraft(),
		onApply: (min, max) => Message.AppliedDuration({ min: min ?? null, max: max ?? null }),
	})

/** Span scope: facets are off, the only filter is "Errored spans only". */
const spanScopeSidebar = (h: HtmlBuilder<Message>, filters: TraceFilters): Html =>
	filterSidebarFrame(h, { className: "w-56 shrink-0 px-4" }, [
		filterSidebarHeader(h, { title: "Span search", onClear: Message.ClickedClearFilters() }),
		...filterSidebarBody(h, "traces-span-filters", [
			h.p(
				[h.Class("py-1 text-xs text-muted-foreground")],
				["Matching any span in a trace, not only its root. Root-span facets are off in this mode."],
			),
			singleCheckboxFilter(h, {
				title: "Errored spans only",
				isChecked: filters.errorsOnly === true,
				onToggle: Message.ToggledErrorsOnly(),
			}),
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					className: "mt-2 w-full",
					attributes: [h.OnClick(Message.ClickedExitSpanScope())],
				},
				["Filter root spans instead"],
			),
		]),
	])

export const sidebar = (
	h: HtmlBuilder<Message>,
	model: Model,
	filters: TraceFilters,
	activeFilterCount: number,
): Html => {
	if (filters.scope === "spans") return spanScopeSidebar(h, filters)
	const maybeFacets = AsyncData.getData(model.facets.data)
	const facets = Option.getOrNull(maybeFacets)
	const services = facets?.services ?? []
	const sections = [
		singleCheckboxFilter(h, {
			title: "Has error",
			isChecked: filters.errorsOnly === true,
			onToggle: Message.ToggledErrorsOnly(),
			count: facets?.errorCount,
		}),
		facet(h, model, "Environment", "env", facets?.deploymentEnvs ?? [], filters.env),
		facet(h, model, "Namespace", "ns", facets?.namespaces ?? [], filters.ns, { isSearchable: true }),
		facet(h, model, "Service", "service", services, filters.service, {
			isSearchable: true,
			colorOf: getServiceColor,
		}),
		facet(h, model, "Root span", "span", facets?.spanNames ?? [], filters.span, { isSearchable: true }),
		durationSection(
			h,
			model,
			filters,
			Option.flatMap(maybeFacets, (loaded) => loaded.maybeDurationStats),
		),
		facet(h, model, "HTTP method", "method", facets?.httpMethods ?? [], filters.method),
		facet(h, model, "Status code", "status", facets?.httpStatusCodes ?? [], filters.status),
	]
	const isFetching = AsyncData.isLoading(model.facets.data) || AsyncData.isRefreshing(model.facets.data)
	return filterSidebarFrame(h, { className: "w-56 shrink-0 px-4", isWaiting: isFetching }, [
		filterSidebarHeader(h, activeFilterCount > 0 ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(
			h,
			"traces-filters",
			sections.filter((section) => section !== null),
		),
	])
}
