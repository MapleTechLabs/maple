import { useNavigate } from "@tanstack/react-router"
import type { WorkflowState } from "@maple/domain/http"
import { Separator } from "@maple/ui/components/ui/separator"

import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@/components/filters/filter-sidebar"
import { WORKFLOW_LABEL } from "@/components/icons/workflow-ring"
import { Route } from "@/routes/errors/index"
import { SEVERITY_LABEL } from "./severity-badge"

const WORKFLOW_ORDER: ReadonlyArray<WorkflowState> = [
	"triage",
	"todo",
	"in_progress",
	"in_review",
	"done",
	"cancelled",
	"wontfix",
]

const WORKFLOW_LABEL_MAP: Record<string, string> = Object.fromEntries(
	WORKFLOW_ORDER.map((state) => [state, WORKFLOW_LABEL[state]]),
)

const SEVERITY_LABEL_MAP: Record<string, string> = {
	critical: SEVERITY_LABEL.critical,
	high: SEVERITY_LABEL.high,
	medium: SEVERITY_LABEL.medium,
	low: SEVERITY_LABEL.low,
	unset: "Unset",
}

const KIND_LABEL_MAP: Record<string, string> = {
	error: "Errors",
	alert: "Alerts",
}

/** Facet counts derived client-side from the fetched issue set (see /errors). */
export interface IssuesFacets {
	workflowState: FilterOption[]
	severity: FilterOption[]
	kind: FilterOption[]
	services: FilterOption[]
}

export function IssuesFilterSidebar({
	facets,
	isRefreshing,
}: {
	facets: IssuesFacets
	isRefreshing?: boolean
}) {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()

	const updateFilter = <K extends keyof typeof search>(key: K, value: (typeof search)[K]) => {
		navigate({
			search: (prev) => ({
				...prev,
				[key]:
					value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
			}),
		})
	}

	const clearAllFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
			},
		})
	}

	const hasActiveFilters =
		(search.workflowState?.length ?? 0) > 0 ||
		(search.severity?.length ?? 0) > 0 ||
		(search.kind?.length ?? 0) > 0 ||
		(search.services?.length ?? 0) > 0 ||
		search.incidentOnly === true ||
		search.includeArchived === true

	return (
		<FilterSidebarFrame waiting={isRefreshing}>
			<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Open incidents only"
					checked={search.incidentOnly ?? false}
					onChange={(checked) => updateFilter("incidentOnly", checked || undefined)}
				/>
				<SingleCheckboxFilter
					title="Include archived"
					checked={search.includeArchived ?? false}
					onChange={(checked) => updateFilter("includeArchived", checked || undefined)}
				/>
				<Separator className="my-2" />

				{facets.workflowState.length > 0 && (
					<>
						<FilterSection
							title="Workflow state"
							options={facets.workflowState}
							selected={search.workflowState ?? []}
							onChange={(val) => updateFilter("workflowState", val)}
							labelMap={WORKFLOW_LABEL_MAP}
							maxVisible={7}
						/>
						<Separator className="my-2" />
					</>
				)}

				{facets.severity.length > 0 && (
					<>
						<FilterSection
							title="Severity"
							options={facets.severity}
							selected={search.severity ?? []}
							onChange={(val) => updateFilter("severity", val)}
							labelMap={SEVERITY_LABEL_MAP}
						/>
						<Separator className="my-2" />
					</>
				)}

				{facets.kind.length > 1 && (
					<>
						<FilterSection
							title="Kind"
							options={facets.kind}
							selected={search.kind ?? []}
							onChange={(val) => updateFilter("kind", val)}
							labelMap={KIND_LABEL_MAP}
						/>
						<Separator className="my-2" />
					</>
				)}

				{facets.services.length > 0 && (
					<SearchableFilterSection
						title="Service"
						options={facets.services}
						selected={search.services ?? []}
						onChange={(val) => updateFilter("services", val)}
					/>
				)}

				{facets.workflowState.length === 0 && facets.services.length === 0 && (
					<p className="py-4 text-sm text-muted-foreground">
						No issues found in the selected time range
					</p>
				)}
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)
}
