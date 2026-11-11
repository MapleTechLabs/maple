import { WIDEN_TIME_PRESET } from "../../kit/time-controls"
import { type PageReturn, PageOutMessage } from "../../contract"
import { AppRoute, hrefOf } from "../../../route"
import { parseRange } from "@maple/views/ui/filters/range-format"
import { WaitDurationDebounce } from "./command"
import { excludedOf, removeTraceFilterChips, type Search, traceFilterChips } from "./derive"
import type { Facet, Message, SortKey } from "./message"
import type { Model } from "./model"
import { clearedWhereClause, withDuration } from "./search-edits"
import { editFacet, excludedValue, onlyValue, toggledValue } from "../../kit/facets"
import { Array as Arr } from "effect"

/** A facet's include param and its excluded twin. */
const paramsOf = (facet: Facet) => ({ include: facet, exclude: excludedOf(facet) })

// The sidebar's and table's Messages: each computes the next search and asks the root to navigate.

type Return = PageReturn<Model, Message>
type Payload<Tag extends Message["_tag"]> = Omit<Extract<Message, { _tag: Tag }>, "_tag">

const navigate = (model: Model, search: Search, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.Traces({ search })), isReplace }),
})

const commitDraft = (model: Model): Return =>
	navigate(
		model,
		withDuration(
			model.search,
			parseRange(model.durationDraft.min, "ms"),
			parseRange(model.durationDraft.max, "ms"),
		),
		true,
	)

export const sidebarHandlers = (model: Model) => ({
	ToggledHasError: (): Return =>
		navigate(model, { ...model.search, hasError: model.search.hasError === true ? undefined : true }),
	ToggledRootOnly: (): Return =>
		navigate(model, { ...model.search, rootOnly: (model.search.rootOnly ?? true) ? false : undefined }),
	ToggledHideNoise: (): Return =>
		navigate(model, { ...model.search, hideNoise: (model.search.hideNoise ?? true) ? false : undefined }),
	ToggledFacetOption: ({ facet, name }: { facet: Facet; name: string }): Return =>
		navigate(
			model,
			editFacet(model.search, paramsOf(facet), (lists) => toggledValue(lists, name)),
		),
	ClickedOnlyFacetOption: ({ facet, name }: { facet: Facet; name: string }): Return =>
		navigate(
			model,
			editFacet(model.search, paramsOf(facet), () => onlyValue(name)),
		),
	ClickedExcludeFacetOption: ({ facet, name }: { facet: Facet; name: string }): Return =>
		navigate(
			model,
			editFacet(model.search, paramsOf(facet), (lists) => excludedValue(lists, name)),
		),
	// Keeps only the absolute bounds here, dropping a relative preset.
	ClickedClearSidebarFilters: (): Return =>
		navigate(model, { startTime: model.search.startTime, endTime: model.search.endTime }),
	ChangedDurationDraft: ({ min, max }: Payload<"ChangedDurationDraft">): Return => {
		const version = model.durationDraftVersion + 1
		return {
			model: { ...model, durationDraft: { min, max }, durationDraftVersion: version },
			commands: [WaitDurationDebounce({ version })],
		}
	},
	ElapsedDurationDebounce: ({ version }: Payload<"ElapsedDurationDebounce">): Return =>
		version === model.durationDraftVersion ? commitDraft(model) : { model },
	CommittedDurationDraft: (): Return =>
		commitDraft({ ...model, durationDraftVersion: model.durationDraftVersion + 1 }),
	AppliedDurationRange: ({ min, max }: Payload<"AppliedDurationRange">): Return =>
		navigate(
			{ ...model, durationDraftVersion: model.durationDraftVersion + 1 },
			withDuration(model.search, min, max),
			true,
		),
})

export const tableHandlers = (model: Model) => ({
	RemovedFilterChip: ({ id }: Payload<"RemovedFilterChip">): Return =>
		navigate(
			model,
			removeTraceFilterChips(
				model.search,
				Arr.filter(traceFilterChips(model.search), (chip) => chip.id === id),
			),
		),
	ClickedClearAllChips: (): Return =>
		navigate(model, removeTraceFilterChips(model.search, traceFilterChips(model.search))),
	ClickedClearWhereClause: (): Return => navigate(model, clearedWhereClause(model.search)),
	// Same column toggles direction; a new column starts at desc.
	ClickedSort: ({ key }: { key: SortKey }): Return => {
		const sortBy = model.search.sortBy ?? "timestamp"
		const sortDir = model.search.sortDir ?? "desc"
		return navigate(model, {
			...model.search,
			sortBy: key,
			sortDir: key === sortBy && sortDir === "desc" ? "asc" : "desc",
		})
	},
	ClickedShowNoise: (): Return => navigate(model, { ...model.search, hideNoise: false }),
	ClickedClearExclusions: (): Return =>
		navigate(
			model,
			removeTraceFilterChips(
				model.search,
				Arr.filter(traceFilterChips(model.search), (chip) => chip.negated),
			),
		),
	ClickedClearFilters: (): Return =>
		navigate(model, {
			...removeTraceFilterChips(model.search, traceFilterChips(model.search)),
			whereClause: undefined,
			hasError: undefined,
			minDurationMs: undefined,
			maxDurationMs: undefined,
			minSpanCount: undefined,
		}),
	ClickedWidenRange: (): Return =>
		navigate(model, {
			...model.search,
			startTime: undefined,
			endTime: undefined,
			timePreset: WIDEN_TIME_PRESET,
		}),
})
