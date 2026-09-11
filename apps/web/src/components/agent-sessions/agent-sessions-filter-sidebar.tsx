import { useMemo } from "react"
import { getRouteApi } from "@tanstack/react-router"
import type { AiSessionDistribution } from "@maple/domain/http"

import { Result } from "@/lib/effect-atom"
import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { percentilePresets, toLogBuckets } from "@/components/filters/range-distribution"
import {
	RangeFilterSection,
	type RangeBucket,
	type RangePreset,
} from "@maple/ui/components/filters/range-filter-section"
import { Separator } from "@maple/ui/components/ui/separator"
import { modelVendorIcon } from "@/lib/agent-sessions/model-vendor-icon"
import { useDetectedModels } from "@/hooks/use-detected-models"
import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"
import {
	AGENT_SESSIONS_FILTER_KEYS,
	hasAgentSessionsFilters,
	type AgentSessionsSearchState,
} from "./agent-sessions-filter-inputs"

const routeApi = getRouteApi("/agent-sessions/")

/** Selected values absent from the current window stay checkable (count 0). */
function withSelected(
	options: ReadonlyArray<FilterOption>,
	selected: ReadonlyArray<string> = [],
): FilterOption[] {
	const missing = selected.filter((value) => !options.some((option) => option.name === value))
	return [...missing.map((name) => ({ name, count: 0 })), ...options]
}

// The shortcuts that name an intent rather than a threshold. The percentiles
// join them once the distributions land; until then these are the presets.
const QUICK_PRESET: RangePreset = { key: "quick", label: "Quick", value: "<10s", max: 10 }
const SINGLE_CALL_PRESET: RangePreset = { key: "single", label: "Single call", value: "1", min: 1, max: 1 }
const NO_TOOLS_PRESET: RangePreset = { key: "none", label: "No tools", value: "0", max: 0 }

type Distributions = Record<
	"durationMs" | "cost" | "totalTokens" | "llmCalls" | "toolCalls",
	AiSessionDistribution
>

/** One range section's histogram and presets. `scale` takes the warehouse's
 *  unit to the control's — ms to the URL's seconds — and `stepsPerOctave` is
 *  the spacing `aiSessionDistributionsQuery` buckets the measure at. */
function distributionControls(
	distribution: AiSessionDistribution | undefined,
	unit: "s" | "usd" | "count",
	stepsPerOctave: number,
	intents: ReadonlyArray<RangePreset>,
	scale = 1,
): { histogram?: RangeBucket[]; presets: RangePreset[] } {
	if (distribution === undefined) return { presets: [...intents] }
	return {
		histogram: toLogBuckets(
			distribution.buckets.map((bucket) => ({ floor: bucket.floor * scale, count: bucket.count })),
			stepsPerOctave,
		),
		presets: [...intents, ...percentilePresets(distribution.p50 * scale, distribution.p95 * scale, unit)],
	}
}

type ListKey = "vendors" | "services" | "environments" | "models" | "agents" | "tools"
type RangeKey =
	| "durationMin"
	| "durationMax"
	| "costMin"
	| "costMax"
	| "tokensMin"
	| "tokensMax"
	| "llmCallsMin"
	| "llmCallsMax"
	| "toolCallsMin"
	| "toolCallsMax"

interface AgentSessionsFilterSidebarProps {
	/**
	 * Distinct sessions per option, aggregated over the whole window rather than
	 * over the page of rows the list returned. Deliberately unfiltered, so
	 * selecting one option leaves the others visible and countable.
	 */
	facetsResult: Result.Result<
		{
			readonly vendors: ReadonlyArray<FilterOption>
			readonly services: ReadonlyArray<FilterOption>
			readonly environments: ReadonlyArray<FilterOption>
			readonly models: ReadonlyArray<FilterOption>
			readonly agents: ReadonlyArray<FilterOption>
			readonly tools: ReadonlyArray<FilterOption>
		},
		unknown
	>
	/**
	 * How the same window's sessions spread over each range, unfiltered like the
	 * facets. A read of its own and a slower one — it nets every session's usage —
	 * so the ranges work from their inputs and intent presets until it lands, or
	 * if it fails.
	 */
	distributionsResult: Result.Result<Distributions, unknown>
}

export function AgentSessionsFilterSidebar({
	facetsResult,
	distributionsResult,
}: AgentSessionsFilterSidebarProps) {
	const navigate = routeApi.useNavigate()
	const search: AgentSessionsSearchState = routeApi.useSearch()

	// Detection is a hook, so the model names have to be read out of the result
	// here rather than inside the success branch below.
	const modelNames = useMemo(
		() =>
			Result.builder(facetsResult)
				.onSuccess((value) => value.models.map((option) => option.name))
				.orElse(() => [] as ReadonlyArray<string>),
		[facetsResult],
	)
	const detectModel = useDetectedModels(modelNames)

	const distributions = Result.builder(distributionsResult)
		.onSuccess((value): Distributions | undefined => value)
		.orElse(() => undefined)
	// Half-octaves for the continuous two, octaves for the counts, whose bounds
	// have to stay whole for the request schema to take them.
	const duration = distributionControls(distributions?.durationMs, "s", 2, [QUICK_PRESET], 1 / 1000)
	const cost = distributionControls(distributions?.cost, "usd", 2, [])
	const tokens = distributionControls(distributions?.totalTokens, "count", 1, [])
	const llmCalls = distributionControls(distributions?.llmCalls, "count", 1, [SINGLE_CALL_PRESET])
	const toolCalls = distributionControls(distributions?.toolCalls, "count", 1, [NO_TOOLS_PRESET])

	const setList = (key: ListKey, values: string[]) => {
		navigate({ search: (prev) => ({ ...prev, [key]: values.length > 0 ? values : undefined }) })
	}

	const setRange =
		(minKey: RangeKey, maxKey: RangeKey) => (min: number | undefined, max: number | undefined) => {
			navigate({ search: (prev) => ({ ...prev, [minKey]: min, [maxKey]: max }) })
		}

	// Everything the sidebar and the toolbar own; the sort stays.
	const clearAllFilters = () => {
		navigate({
			search: (prev) => ({
				...prev,
				...Object.fromEntries(AGENT_SESSIONS_FILTER_KEYS.map((key) => [key, undefined])),
			}),
		})
	}

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={4} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((value, result) => {
			const vendors = withSelected(value.vendors, search.vendors)
			const services = withSelected(value.services, search.services)
			const environments = withSelected(value.environments, search.environments)
			const models = withSelected(value.models, search.models)
			const agents = withSelected(value.agents, search.agents)
			const tools = withSelected(value.tools, search.tools)

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader
						canClear={hasAgentSessionsFilters(search)}
						onClear={clearAllFilters}
					/>
					<FilterSidebarBody>
						{/* Counted facets first — they answer "what is in here" before you
						    know anything. The measured ranges follow, then the one structural
						    toggle. "With errors" is deliberately absent: the toolbar chip is
						    that filter, and two controls for one boolean read as a question
						    about whether they agree. */}
						{/* Sections with nothing to offer hide themselves: most orgs never
						    set an environment, and a framework that names no agents or tools
						    would leave an empty list that reads as broken. */}
						{agents.length > 0 && (
							<SearchableFilterSection
								title="Agent"
								options={agents}
								selected={search.agents ?? []}
								onChange={(vals) => setList("agents", vals)}
							/>
						)}

						{tools.length > 0 && (
							<SearchableFilterSection
								title="Tool"
								options={tools}
								selected={search.tools ?? []}
								onChange={(vals) => setList("tools", vals)}
							/>
						)}

						<SearchableFilterSection
							title="Service"
							options={services}
							selected={search.services ?? []}
							onChange={(vals) => setList("services", vals)}
						/>

						<FilterSection
							title="Framework"
							options={vendors}
							selected={search.vendors ?? []}
							onChange={(vals) => setList("vendors", vals)}
							getOptionLabel={vendorLabel}
							getOptionIcon={vendorIcon}
						/>

						{models.length > 0 && (
							<SearchableFilterSection
								title="Model"
								options={models}
								selected={search.models ?? []}
								onChange={(vals) => setList("models", vals)}
								getOptionLabel={(name) => detectModel(name).displayName}
								getOptionIcon={(name) => modelVendorIcon(detectModel(name))}
							/>
						)}

						{environments.length > 0 && (
							<FilterSection
								title="Environment"
								options={environments}
								selected={search.environments ?? []}
								onChange={(vals) => setList("environments", vals)}
							/>
						)}

						<Separator className="my-2" />

						{/* Each histogram counts the sessions where its measure is above
						    zero — a log axis has no place for none — so the readouts that
						    would otherwise overstate what they hold say who they count. */}
						<RangeFilterSection
							title="Session length"
							unit="s"
							minValue={search.durationMin}
							maxValue={search.durationMax}
							onRangeChange={setRange("durationMin", "durationMax")}
							histogram={duration.histogram}
							presets={duration.presets}
						/>

						<RangeFilterSection
							title="Cost"
							hint="As priced by the instrumentation"
							unit="usd"
							minValue={search.costMin}
							maxValue={search.costMax}
							onRangeChange={setRange("costMin", "costMax")}
							histogram={cost.histogram}
							histogramUnitLabel="priced sessions"
							presets={cost.presets}
						/>

						<RangeFilterSection
							title="Tokens"
							unit="count"
							minValue={search.tokensMin}
							maxValue={search.tokensMax}
							onRangeChange={setRange("tokensMin", "tokensMax")}
							histogram={tokens.histogram}
							presets={tokens.presets}
						/>

						<RangeFilterSection
							title="LLM calls"
							unit="count"
							minValue={search.llmCallsMin}
							maxValue={search.llmCallsMax}
							onRangeChange={setRange("llmCallsMin", "llmCallsMax")}
							histogram={llmCalls.histogram}
							presets={llmCalls.presets}
						/>

						<RangeFilterSection
							title="Tool calls"
							unit="count"
							minValue={search.toolCallsMin}
							maxValue={search.toolCallsMax}
							onRangeChange={setRange("toolCallsMin", "toolCallsMax")}
							histogram={toolCalls.histogram}
							histogramUnitLabel="sessions with tools"
							presets={toolCalls.presets}
						/>

						<Separator className="my-2" />

						{/* A framework with no session key files every trace as its own
						    session; for an org running one of those this is the difference
						    between a list of conversations and a list of requests. */}
						<SingleCheckboxFilter
							title="Hide single-trace sessions"
							checked={search.grouped === true}
							onChange={(checked) =>
								navigate({ search: (prev) => ({ ...prev, grouped: checked || undefined }) })
							}
						/>

						{vendors.length === 0 && services.length === 0 && (
							<p className="py-4 text-sm text-muted-foreground">
								No sessions in the last 7 days
							</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
