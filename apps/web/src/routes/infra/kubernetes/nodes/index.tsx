import { FilteredEmpty } from "@/components/common/filtered-empty"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { ErrorState } from "@/components/common/error-state"
import { MagnifierIcon, ServerIcon } from "@/components/icons"
import { InfraSetupEmpty } from "@/components/infra/infra-empty-state"
import { KubernetesShell } from "@/components/infra/kubernetes/kubernetes-shell"
import { NodeTable, NodeTableLoading } from "@/components/infra/node-table"
import { deriveHostStatus, type HostStatus } from "@/components/infra/format"
import { NodesFilterSidebarView, type NodeFilters } from "@/components/infra/k8s-filter-sidebar"
import { FleetBand, type FleetBandCell } from "@/components/infra/primitives/fleet-band"
import { SearchToolbar, countLabel } from "@/components/common/search-toolbar"
import { statusLabel } from "@/components/infra/severity-tokens"
import { listNodesResultAtom, nodeFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { TONE_FILL } from "@maple/ui/lib/tone"

const DEFAULT_PRESET = "12h"

const NodeStatusParam = Schema.optional(Schema.Literals(["active", "idle", "ended"]))

const nodesSearchSchema = Schema.Struct({
	q: Schema.optional(Schema.String),
	status: NodeStatusParam,
	nodeNames: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export type NodesSearchParams = Schema.Schema.Type<typeof nodesSearchSchema>

export const Route = createFileRoute("/infra/kubernetes/nodes/")({
	component: NodesPage,
	validateSearch: Schema.toStandardSchemaV1(nodesSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

/**
 * The states are collector freshness, not Kubernetes conditions: a node is
 * "Ended" here when no kubelet metric has arrived recently, which on an ASG or
 * a Karpenter-managed fleet usually means the node was scaled in, not that it
 * failed — so it reads neutral. `k8s.node.condition_ready` is collected but
 * unqueried; when it lands it belongs beside these, not instead.
 */
const STATUS_CELLS: ReadonlyArray<{
	status: HostStatus
	hint: string
	tone: FleetBandCell<HostStatus>["tone"]
}> = [
	{ status: "active", hint: "reporting", tone: "info" },
	{ status: "idle", hint: "quiet >1m", tone: "warn" },
	{ status: "ended", hint: "silent >5m", tone: "neutral" },
]

const STATUS_SEGMENT: Record<HostStatus, string> = {
	active: TONE_FILL.info,
	idle: TONE_FILL.warn,
	ended: "bg-muted-foreground/40",
} satisfies Record<HostStatus, string>

function NodesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const searchText = search.q ?? ""
	const statusScope = search.status

	const patchSearch = (patch: Partial<NodesSearchParams>) => {
		void navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const timeSearch = pickTimeRangeSearch(search)

	const filters: NodeFilters = {
		nodeNames: search.nodeNames,
		clusters: search.clusters,
		environments: search.environments,
	}

	const nodesResult = useAtomValue(listNodesResultAtom({ data: { startTime, endTime, ...filters } }))
	const facetsResult = useAtomValue(nodeFacetsResultAtom({ data: { startTime, endTime } }))

	const onFilterChange = <K extends keyof NodeFilters>(key: K, value: NodeFilters[K]) => {
		patchSearch({
			[key]: value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
		})
	}

	const onClearFilters = () => {
		void navigate({ search: timeSearch })
	}

	return (
		<KubernetesShell
			view="nodes"
			timeSearch={search}
			startTime={startTime}
			endTime={endTime}
			defaultPreset={DEFAULT_PRESET}
			onTimeChange={(range, options) =>
				void navigate({
					replace: options?.replace,
					search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
				})
			}
			filters={
				<NodesFilterSidebarView
					facetsResult={facetsResult}
					filters={filters}
					onFilterChange={onFilterChange}
					onClearFilters={onClearFilters}
				/>
			}
		>
			{Result.builder(nodesResult)
				.onInitial(() => <NodeTableLoading />)
				.onError((err) => <ErrorState error={err} />)
				.onSuccess((response, result) => {
					const nodes = response.data
					const hasStructuredFilter = Object.values(filters).some((v) => (v?.length ?? 0) > 0)

					if (nodes.length === 0 && !hasStructuredFilter) {
						return (
							<InfraSetupEmpty
								icon={<ServerIcon size={16} />}
								title="No nodes reporting yet"
								description="Install the Maple Kubernetes Helm chart so the kubelet stats receiver can start collecting per-node metrics."
								installTab="kubernetes"
								actionLabel="Install the Helm chart"
								docs="kubernetes"
							/>
						)
					}

					// The band counts the whole scope as of the window's end, so it keeps
					// saying what the search and the status cell just hid.
					const counts = { active: 0, idle: 0, ended: 0 } satisfies Record<HostStatus, number>
					for (const node of nodes) counts[deriveHostStatus(node.lastSeen, endTime)]++

					const q = searchText.trim().toLowerCase()
					const named = q ? nodes.filter((n) => n.nodeName.toLowerCase().includes(q)) : nodes
					const filtered = statusScope
						? named.filter((n) => deriveHostStatus(n.lastSeen, endTime) === statusScope)
						: named

					return (
						<div
							className={cn("space-y-5", refreshingClass(result.waiting))}
							aria-busy={result.waiting || undefined}
						>
							<FleetBand
								total={nodes.length}
								noun="node"
								caption="share of the fleet by collector freshness"
								segments={STATUS_CELLS.map(({ status }) => ({
									key: statusLabel(status).toLowerCase(),
									count: counts[status],
									className: STATUS_SEGMENT[status],
								}))}
								cells={STATUS_CELLS.map(({ status, hint, tone }) => ({
									scope: status,
									label: statusLabel(status),
									hint,
									value: counts[status],
									tone,
								}))}
								activeScope={statusScope}
								onScopeChange={(next) => patchSearch({ status: next })}
								waiting={result.waiting}
							/>
							<div className="space-y-3">
								<SearchToolbar
									value={searchText}
									onChange={(value) => patchSearch({ q: value || undefined })}
									placeholder="Search nodes…"
									trailing={countLabel(filtered.length, filtered.length, "node")}
								/>
								{(q || statusScope) && filtered.length === 0 ? (
									<FilteredEmpty
										noun="nodes"
										className="py-12"
										icon={<MagnifierIcon size={16} />}
										title="No nodes match"
										description={
											q
												? `Nothing named “${searchText}” in this scope.`
												: "Nothing in this scope right now, which is good news."
										}
										onClear={() => patchSearch({ q: undefined, status: undefined })}
										clearLabel={q ? "Clear search" : "Show all nodes"}
									/>
								) : (
									<NodeTable
										nodes={filtered}
										waiting={result.waiting}
										referenceTime={endTime}
									/>
								)}
							</div>
						</div>
					)
				})
				.render()}
		</KubernetesShell>
	)
}
