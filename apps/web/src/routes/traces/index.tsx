import * as React from "react"
import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { warmAtoms } from "@effect-router/core"
import { Schema } from "effect"

import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { TracesTable } from "@/components/traces/traces-table"
import { TracesFilterSidebar } from "@/components/traces/traces-filter-sidebar"
import { AdvancedFilterDialog } from "@/components/traces/advanced-filter-dialog"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Panel } from "@maple/ui/components/ui/panel"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { resolveEffectiveTimeRange, useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useAtomValue } from "@/lib/effect-atom"
import { applyWhereClause } from "@/lib/traces/advanced-filter-sync"
import { getTracesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { AutocompleteValuesProvider } from "@/hooks/use-autocomplete-values"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { removeTraceFilterChips, traceFilterChips } from "@/lib/traces/trace-filter-chips"
import { useGlobalNamespace } from "@/hooks/use-global-namespace"

const ContainsMatchMode = Schema.optional(Schema.Literals(["contains"]))

const TraceSortKeyParam = Schema.optional(Schema.Literals(["timestamp", "durationMs"]))
const SortDirParam = Schema.optional(Schema.Literals(["asc", "desc"]))

const attributeFilterParamFields = {
	key: Schema.String,
	value: Schema.String,
	matchMode: Schema.optional(Schema.Literals(["contains", "exists", "gt", "gte", "lt", "lte"])),
	negated: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
}

const AttributeFilterParam = Schema.Struct({
	...attributeFilterParamFields,
	/** The other members of an `(a OR b)` where-clause group. */
	or: Schema.optional(Schema.Array(Schema.Struct(attributeFilterParamFields))),
})

const tracesSearchSchema = Schema.Struct({
	services: OptionalStringArrayParam,
	spanNames: OptionalStringArrayParam,
	hasError: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	minDurationMs: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	maxDurationMs: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	httpMethods: OptionalStringArrayParam,
	httpStatusCodes: OptionalStringArrayParam,
	deploymentEnvs: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	rootOnly: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	// Server-side drop of single-span non-entry-point traces (ui.screen
	// breadcrumbs, orphaned client spans). Defaults on; `hideNoise=false` shows
	// everything.
	hideNoise: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	minSpanCount: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	whereClause: Schema.optional(Schema.String),
	attributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	/** The trace open in the peek sheet. In the URL so it survives a reload and a share. */
	peek: Schema.optional(Schema.String),
	/** The row's own span id, only when the list is per-span and rows share a trace. */
	peekRow: Schema.optional(Schema.String),
	/** A timestamp inside the peeked trace, so a peek whose row is not loaded still prunes partitions. */
	peekT: Schema.optional(Schema.String),
	/** The span selected inside the peek — the page's `spanId`, kept apart so closing the peek clears it. */
	peekSpan: Schema.optional(Schema.String),
	serviceMatchMode: ContainsMatchMode,
	spanNameMatchMode: ContainsMatchMode,
	deploymentEnvMatchMode: ContainsMatchMode,
	namespaceMatchMode: ContainsMatchMode,
	excludedServices: OptionalStringArrayParam,
	excludedSpanNames: OptionalStringArrayParam,
	excludedDeploymentEnvs: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	excludedHttpMethods: OptionalStringArrayParam,
	excludedHttpStatusCodes: OptionalStringArrayParam,
	// Sorting is server-side: the list is paged, so sorting the rows already
	// fetched would only reorder the current window.
	sortBy: TraceSortKeyParam,
	sortDir: SortDirParam,
	...TimeRangeSearchFields,
})

export type TracesSearchParams = Schema.Schema.Type<typeof tracesSearchSchema>

export const Route = createFileRoute("/traces/")({
	component: TracesPage,
	validateSearch: Schema.toStandardSchemaV1(tracesSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
	loaderDeps: ({ search }) => search,
	// Only the facet sidebar is warmed. The trace list is paginated and sorted
	// from state the route does not own, so rebuilding its input here would risk
	// warming a different entry than the table reads — two fetches instead of
	// none.
	loader: ({ context, deps }) => {
		const { startTime, endTime } = resolveEffectiveTimeRange(
			deps.startTime,
			deps.endTime,
			deps.timePreset ?? "12h",
		)
		warmAtoms(context.effectRegistry, [getTracesFacetsResultAtom({ data: { startTime, endTime } })])
	},
})

function TracesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const pinnedNamespace = useGlobalNamespace()

	const handleApplyWhereClause = React.useCallback(
		(newClause: string) => {
			navigate({
				search: (prev) => applyWhereClause(prev, newClause),
			})
		},
		[navigate],
	)

	const activeFilterChips = React.useMemo(
		() =>
			traceFilterChips(search)
				// URL namespace filters are ignored while the org-global pin is on —
				// chips for them would suggest they still apply.
				.filter(
					(chip) =>
						pinnedNamespace === null ||
						(chip.id !== "namespaces" && chip.id !== "excludedNamespaces"),
				)
				.map((chip) => ({
					id: chip.id,
					label: chip.label,
					values: chip.values,
					negated: chip.negated,
					onRemove: () => navigate({ search: (prev) => chip.remove(prev) }),
				})),
		[search, navigate, pinnedNamespace],
	)

	const clearFacetFilters = React.useCallback(() => {
		navigate({
			search: (prev) => removeTraceFilterChips(prev, traceFilterChips(prev)),
		})
	}, [navigate])

	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const facetsResult = useAtomValue(
		getTracesFacetsResultAtom({
			data: {
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
			},
		}),
	)

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({
				...applyTimeRangeSearch(prev, range),
			}),
		})
	}

	return (
		// lazy: the ~4 autocomplete warehouse queries (logs facets + attribute
		// keys) are only needed by the advanced-filter editor, which calls
		// activate() on focus/open — don't fire them on every page mount.
		<AutocompleteValuesProvider lazy startTime={effectiveStartTime} endTime={effectiveEndTime}>
			<DashboardPage
				breadcrumbs={[{ label: "Traces" }]}
				headerActions={
					<AdvancedFilterDialog
						initialValue={search.whereClause ?? ""}
						onApply={handleApplyWhereClause}
					/>
				}
				time={{
					search,
					startTime: effectiveStartTime,
					endTime: effectiveEndTime,
					defaultPreset: "12h",
					onChange: handleTimeChange,
				}}
				filters={<TracesFilterSidebar facetsResult={facetsResult} />}
			>
				{search.whereClause && (
					<Panel
						tone="muted"
						className="mb-4 flex-row items-center justify-between gap-2 px-3 py-2"
					>
						<div className="flex min-w-0 items-center gap-2">
							<MagnifierIcon className="size-3.5 shrink-0 text-primary" />
							<TruncatedText mono className="text-xs text-foreground" tooltip="overflow">
								{search.whereClause}
							</TruncatedText>
						</div>
						<IconButton
							label="Clear filter"
							size="icon-xs"
							onClick={() => handleApplyWhereClause("")}
							className="shrink-0 text-muted-foreground hover:text-foreground"
						>
							<XmarkIcon />
						</IconButton>
					</Panel>
				)}
				<ActiveFilterChips chips={activeFilterChips} onClearAll={clearFacetFilters} />
				<TracesTable filters={search} />
			</DashboardPage>
		</AutocompleteValuesProvider>
	)
}
