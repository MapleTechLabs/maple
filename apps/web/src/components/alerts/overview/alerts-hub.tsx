import * as AsyncResult from "effect/reactivity/AsyncResult"
import { memo, type ReactNode } from "react"

import type { AlertDestinationDocument, AlertRuleDocument } from "@maple/domain/http"
import { Unitflow, View } from "@maple/unitflow/react"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"

import { InboxTab } from "@/components/alerts/overview/inbox-tab"
import { RulesTab } from "@/components/alerts/overview/rules-tab"
import { ErrorState } from "@/components/common/error-state"
import type { RuleBucket } from "@/lib/alerts/overview-derive"
import { AlertsOverviewModel, type AlertsOverviewReady } from "@/lib/models/alerts-overview-model"
import { unitflowRuntime } from "@/lib/models/runtime"

export interface AlertsTabCounts {
	readonly open: number
	readonly rules: number
}

/** Renders `children` with the open-incident and rule counts once the overview is ready. */
export function AlertsTabCountsBoundary({
	children,
}: {
	children: (counts: AlertsTabCounts | null) => ReactNode
}) {
	return (
		<Unitflow
			runtime={unitflowRuntime}
			rootModel={AlertsOverviewModel}
			building={children(null)}
			failed={() => children(null)}
		>
			{(unit) => <TabCountsView unit={unit} render={children} />}
		</Unitflow>
	)
}

const TabCountsView = View.make(
	AlertsOverviewModel,
	({ overview }, { render }: { render: (counts: AlertsTabCounts | null) => ReactNode }) =>
		render(
			overview.phase === "ready"
				? { open: overview.openIncidents.length, rules: overview.rules.length }
				: null,
		),
)

export interface AlertsHubProps {
	readonly tab: "inbox" | "rules"
	readonly destinations: ReadonlyArray<AlertDestinationDocument>
	readonly isAdmin: boolean
	readonly serviceName: string | undefined
	readonly status: RuleBucket | undefined
	readonly onStatusChange: (status: RuleBucket | undefined) => void
}

/** Inbox and Rules both render the derived overview model; this owns its lifecycle. */
export function AlertsHub(props: AlertsHubProps) {
	return (
		<Unitflow
			runtime={unitflowRuntime}
			rootModel={AlertsOverviewModel}
			building={<HubSkeleton />}
			failed={() => <HubLoadError />}
		>
			{(unit) => <HubBody unit={unit} {...props} />}
		</Unitflow>
	)
}

const HUB_SKELETON_ROWS = ["h-14 w-1/2", "h-40 w-full", "h-48 w-full"]

function HubSkeleton() {
	return (
		<SkeletonList
			rows={HUB_SKELETON_ROWS.length}
			gap="6"
			renderRow={(index) => <Skeleton className={HUB_SKELETON_ROWS[index]} />}
		/>
	)
}

function HubLoadError() {
	return (
		<ErrorState
			error="The alert rules stream could not be loaded."
			title="Failed to load alert rules"
			onRetry={() => window.location.reload()}
			className="py-12"
		/>
	)
}

const HubBody = View.make(
	AlertsOverviewModel,
	({ overview, toggleRule, toggleState }, props: AlertsHubProps) => {
		if (overview.phase === "loading") return <HubSkeleton />
		if (overview.phase === "error") return <HubLoadError />
		return <HubContent data={overview} onToggleRule={toggleRule} toggleState={toggleState} {...props} />
	},
)

const HubContent = memo(function HubContent({
	data,
	onToggleRule,
	toggleState,
	tab,
	destinations,
	isAdmin,
	serviceName,
	status,
	onStatusChange,
}: AlertsHubProps & {
	data: AlertsOverviewReady
	onToggleRule: (rule: AlertRuleDocument) => void
	toggleState: AsyncResult.AsyncResult<unknown, unknown>
}) {
	if (tab === "inbox") {
		return (
			<InboxTab data={data} destinations={destinations} isAdmin={isAdmin} serviceName={serviceName} />
		)
	}
	return (
		<RulesTab
			data={data}
			destinations={destinations}
			isAdmin={isAdmin}
			serviceName={serviceName}
			status={status}
			onStatusChange={onStatusChange}
			isToggling={AsyncResult.isWaiting(toggleState)}
			toggleFailed={AsyncResult.isFailure(toggleState)}
			onToggleRule={onToggleRule}
		/>
	)
})
