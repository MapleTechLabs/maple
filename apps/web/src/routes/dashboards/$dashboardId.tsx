import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { DashboardId, DashboardVersionId } from "@maple/domain/http"
import { Atom, useAtom } from "@/lib/effect-atom"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { DashboardSections } from "@/components/dashboard-builder/sections/dashboard-sections"
import { BlankDashboardEmpty } from "@/components/dashboard-builder/blank-dashboard-empty"
import { LiveWidgetRenderer } from "@/components/dashboard-builder/canvas/live-widget-renderer"
import {
	withActiveTab,
	withSectionCollapsed,
	type SectionViewSearch,
} from "@/lib/dashboards/section-view-state"
import { DashboardToolbar } from "@/components/dashboard-builder/toolbar/dashboard-toolbar"
import { WidgetPicker } from "@/components/dashboard-builder/config/chart-picker"
import { InlineEditableTitle } from "@/components/dashboard-builder/inline-editable-title"
import {
	DashboardTimeRangeWrapper,
	useDashboardTimeRange,
} from "@/components/dashboard-builder/dashboard-providers"
import { DashboardVariablesProvider } from "@/components/dashboard-builder/dashboard-variables-context"
import {
	VARIABLE_PARAM_PREFIX,
	dashboardViewParamsSchema,
	pickDashboardControlParams,
	resolveRefreshIntervalSeconds,
	variableSearchRest,
	variableValuesFromSearch,
} from "@/lib/dashboard-controls/search-params"
import {
	DashboardActionsProvider,
	useDashboardActions,
} from "@/components/dashboard-builder/dashboard-actions-context"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { WidgetMode } from "@/components/dashboard-builder/types"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import { DashboardHistoryPanel, PreviewedCanvas } from "@/components/dashboard-builder/history"
import { DashboardViewSkeleton } from "@/components/dashboard-builder/loading-skeletons"
import { SyncDegradedBanner, SyncUnavailable } from "@/components/common/sync-unavailable"
import { ResourceNotFound } from "@/components/common/resource-not-found"
import { CRUMB_ERROR, CRUMB_LOADING } from "@/components/layout/result-page"
import { historyPanelOpenAtom, previewedVersionAtom } from "@/atoms/dashboard-history-atoms"
import { useDashboardVersions } from "@/components/dashboard-builder/history/use-dashboard-history"
import { Result } from "@/lib/effect-atom"
import { useMemo, useState, type ReactNode } from "react"
import type { DashboardRefreshIntervalSeconds, SectionTarget } from "@maple/domain/http"

// Module-level atoms — singleton (only one dashboard page visible at a time)
const chartPickerOpenAtom = Atom.make(false)

// Decode the raw `$dashboardId` URL segment into its branded id once, at the
// route boundary, so the branded value threads through the store/history hooks
// without a per-call cast.
const asDashboardId = Schema.decodeSync(DashboardId)

// `var-<name>` keys carry dashboard-variable selections (Grafana-style), so
// views are shareable/deep-linkable. Values are `Unknown` on purpose: TanStack
// JSON-parses each search value, and a hand-edited URL must never crash the
// route — non-string values are coerced or ignored when read.
const dashboardViewSearchSchema = Schema.StructWithRest(
	Schema.Struct({
		mode: Schema.optional(Schema.Literal("edit")),
		...dashboardViewParamsSchema,
	}),
	[variableSearchRest],
)

export const Route = createFileRoute("/dashboards/$dashboardId")({
	component: DashboardViewPage,
	validateSearch: Schema.toStandardSchemaV1(dashboardViewSearchSchema),
})

function DashboardRefreshBridge({
	children,
	refreshIntervalSeconds,
	paused,
}: {
	children: ReactNode
	refreshIntervalSeconds: DashboardRefreshIntervalSeconds
	paused: boolean
}) {
	const {
		state: { timeRange },
	} = useDashboardTimeRange()
	const timePreset = timeRange.type === "relative" ? timeRange.value : undefined
	return (
		<PageRefreshProvider
			timePreset={timePreset}
			autoRefreshMs={refreshIntervalSeconds * 1000}
			autoRefreshPaused={paused}
		>
			{children}
		</PageRefreshProvider>
	)
}

function DashboardViewPage() {
	const { dashboardId: dashboardIdParam } = Route.useParams()
	const dashboardId = asDashboardId(dashboardIdParam)
	const search = Route.useSearch()
	const navigate = useNavigate()

	const {
		dashboards,
		isLoading,
		isError,
		degraded,
		retry,
		readOnly,
		persistenceError,
		updateDashboard,
		updateDashboardTimeRange,
		updateDashboardRefreshInterval,
		addWidget,
		cloneWidget,
		removeWidget,
		restoreWidget,
		updateWidgetDisplay,
		updateWidget,
		updateWidgetLayouts,
		autoLayoutWidgets,
		addSection,
		renameSection,
		setSectionCollapsedDefault,
		setSectionCollapsible,
		reorderSections,
		deleteSection,
		addTab,
		renameTab,
		deleteTab,
		moveWidgetToSection,
	} = useDashboardStore()

	const [chartPickerOpen, setChartPickerOpen] = useAtom(chartPickerOpenAtom)
	// Which grid the picker's next widget lands in. Set by a group's own "+",
	// cleared by the toolbar's, so the two entry points can't drift.
	const [pendingSectionTarget, setPendingSectionTarget] = useState<SectionTarget>(null)
	const [historyPanelOpen, setHistoryPanelOpen] = useAtom(historyPanelOpenAtom)
	const [previewed, setPreviewed] = useAtom(previewedVersionAtom)

	const activeDashboard = dashboards.find((d) => d.id === dashboardId)

	const isPreviewing = previewed !== null
	const mode: WidgetMode = search.mode === "edit" && !readOnly && !isPreviewing ? "edit" : "view"

	// Functional search updates so toggling edit mode never wipes the per-viewer
	// controls (`var-*` selections, filter clause, section collapse, active tabs).
	const handleToggleEdit = () => {
		if (isPreviewing) return
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			search: (prev) =>
				mode === "edit"
					? pickDashboardControlParams(prev)
					: { ...pickDashboardControlParams(prev), mode: "edit" as const },
		})
	}

	// `?refresh=` is per-viewer and wins over the board's saved cadence, so a
	// read-only viewer can start (or silence) auto-refresh without touching the
	// document. Picking one always writes the param; in edit mode it *also*
	// becomes the dashboard's default, which is the only path that cuts a version.
	const refreshIntervalSeconds = resolveRefreshIntervalSeconds(
		search.refresh,
		activeDashboard?.refreshIntervalSeconds,
	)

	const handleRefreshIntervalChange = (next: DashboardRefreshIntervalSeconds) => {
		if (mode === "edit" && !readOnly && !isPreviewing) {
			updateDashboardRefreshInterval(dashboardId, next)
		}
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			replace: true,
			search: (prev) => ({
				...pickDashboardControlParams(prev),
				...(prev.mode === "edit" ? { mode: "edit" as const } : undefined),
				refresh: next,
			}),
		})
	}

	const urlVariableValues = useMemo(() => variableValuesFromSearch(search), [search])

	const handleVariableChange = (name: string, value: string) => {
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			replace: true,
			search: (prev) => ({
				...pickDashboardControlParams(prev),
				...(prev.mode === "edit" ? { mode: "edit" as const } : undefined),
				[`${VARIABLE_PARAM_PREFIX}${name}`]: value,
			}),
		})
	}

	const openHistory = () => {
		setHistoryPanelOpen(true)
	}

	// Section view state is per-viewer: it rides the URL with `replace` so
	// collapsing a group doesn't fill the back button with layout noise, and it
	// never touches the stored document.
	//
	// The update is applied *to* the picked params rather than spread over them.
	// `withSectionCollapsed` signals "drop this key" by deleting it from the
	// object it returns, and `{...base, ...update(prev)}` silently undoes that —
	// the deleted key simply isn't there to overwrite the stale value, so an id
	// toggled twice ends up in both `collapsed` and `expanded`, and `expanded`
	// wins, pinning the group open forever.
	//
	// `mode` is re-added for the same class of reason: `pickDashboardControlParams`
	// deliberately drops it, so without this, collapsing a group while editing
	// would quietly kick the user out of edit mode.
	const applySectionView = (update: (prev: SectionViewSearch) => SectionViewSearch) => {
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			replace: true,
			search: (prev) => ({
				...update(pickDashboardControlParams(prev)),
				...(prev.mode === "edit" ? { mode: "edit" as const } : undefined),
			}),
		})
	}

	const sectionViewSearch: SectionViewSearch = {
		collapsed: search.collapsed,
		expanded: search.expanded,
		tab: search.tab,
		widget: search.widget,
	}

	if (!activeDashboard) {
		// A dead sync stream must not masquerade as a missing dashboard: the row may
		// exist and simply never have arrived.
		const [crumb, body] = isLoading
			? [CRUMB_LOADING, <DashboardViewSkeleton />]
			: isError
				? [
						CRUMB_ERROR,
						<SyncUnavailable
							title="Couldn’t load this dashboard"
							description="The sync stream isn’t reachable, so the dashboard couldn’t be read. Nothing has been lost — this is a read problem."
							onRetry={retry}
						/>,
					]
				: [
						"Not found",
						<ResourceNotFound
							title="Dashboard not found"
							description={
								<>
									No dashboard with id{" "}
									<InlineCode className="break-all px-1.5 py-0.5">{dashboardId}</InlineCode>
								</>
							}
							backLink={<Link to="/dashboards" />}
							backLabel="Back to all dashboards"
							className="py-24"
						/>,
					]
		return (
			<DashboardPage breadcrumbs={[{ label: "Dashboards", href: "/dashboards" }, { label: crumb }]}>
				{body}
			</DashboardPage>
		)
	}

	return (
		<DashboardTimeRangeWrapper
			key={dashboardId}
			initialTimeRange={activeDashboard.timeRange}
			onTimeRangeChange={(timeRange) => updateDashboardTimeRange(activeDashboard.id, timeRange)}
		>
			<DashboardVariablesProvider
				variables={activeDashboard.variables}
				urlValues={urlVariableValues}
				onValueChange={handleVariableChange}
			>
				<DashboardActionsProvider
					dashboardId={dashboardId}
					mode={mode}
					readOnly={readOnly || isPreviewing}
					sections={activeDashboard.sections ?? []}
					store={{
						addWidget,
						removeWidget,
						restoreWidget,
						cloneWidget,
						updateWidgetDisplay,
						updateWidget,
						updateWidgetLayouts,
						autoLayoutWidgets,
						addSection,
						renameSection,
						setSectionCollapsedDefault,
						setSectionCollapsible,
						reorderSections,
						deleteSection,
						addTab,
						renameTab,
						deleteTab,
						moveWidgetToSection,
					}}
				>
					<DashboardRefreshBridge
						refreshIntervalSeconds={refreshIntervalSeconds}
						paused={mode === "edit" || isPreviewing}
					>
						<DashboardPage
							breadcrumbs={[
								{ label: "Dashboards", href: "/dashboards" },
								{ label: activeDashboard.name },
							]}
							titleContent={
								<InlineEditableTitle
									value={activeDashboard.name}
									readOnly={readOnly || isPreviewing}
									onChange={(name) => updateDashboard(dashboardId, { name })}
								/>
							}
							headerActions={
								<DashboardToolbar
									dashboard={activeDashboard}
									onToggleEdit={handleToggleEdit}
									onAddWidget={() => setChartPickerOpen(true)}
									onOpenHistory={openHistory}
									refreshIntervalSeconds={refreshIntervalSeconds}
									onRefreshIntervalChange={handleRefreshIntervalChange}
								/>
							}
							rightPanel={
								historyPanelOpen ? (
									<HistoryPanelMount
										dashboardId={dashboardId}
										onClose={() => {
											setHistoryPanelOpen(false)
											setPreviewed(null)
										}}
									/>
								) : undefined
							}
						>
							{degraded && <SyncDegradedBanner onRetry={retry} />}
							{persistenceError && (
								<Alert variant="crit" size="sm" className="mb-4">
									<AlertDescription className={TONE_TEXT.crit}>
										{persistenceError}. Dashboard editing is temporarily disabled.
									</AlertDescription>
								</Alert>
							)}

							{isPreviewing && previewed ? (
								<PreviewedCanvas
									dashboardId={dashboardId}
									preview={previewed}
									onCancel={() => setPreviewed(null)}
									onRestored={() => setPreviewed(null)}
								/>
							) : activeDashboard.widgets.length === 0 &&
							  (activeDashboard.sections?.length ?? 0) === 0 ? (
								// Shown while editing too: an edit-mode board with nothing on it
								// renders as a blank page, which reads as a failed load.
								<BlankDashboardEmpty
									readOnly={readOnly}
									onAddWidget={() => {
										if (mode !== "edit") {
											navigate({
												to: "/dashboards/$dashboardId",
												params: { dashboardId },
												search: (prev) => ({
													...pickDashboardControlParams(prev),
													mode: "edit" as const,
												}),
											})
										}
										setChartPickerOpen(true)
									}}
								/>
							) : (
								<DashboardSections
									renderWidget={LiveWidgetRenderer}
									widgets={activeDashboard.widgets}
									sections={activeDashboard.sections ?? []}
									search={sectionViewSearch}
									onToggleCollapsed={(sectionId, collapsed) =>
										applySectionView((prev) =>
											withSectionCollapsed(prev, sectionId, collapsed),
										)
									}
									onSelectTab={(sectionId, tabId) =>
										applySectionView((prev) => withActiveTab(prev, sectionId, tabId))
									}
									onAddWidget={(sectionId, tabId) => {
										setPendingSectionTarget({ sectionId, tabId })
										setChartPickerOpen(true)
									}}
								/>
							)}

							<WidgetPickerWithActions
								open={readOnly || isPreviewing ? false : chartPickerOpen}
								target={pendingSectionTarget}
								onOpenChange={
									readOnly || isPreviewing
										? () => undefined
										: (open) => {
												setChartPickerOpen(open)
												// Reset on close so the next toolbar "Add
												// widget" lands on the root canvas rather
												// than inheriting the last group used.
												if (!open) setPendingSectionTarget(null)
											}
								}
							/>
						</DashboardPage>
					</DashboardRefreshBridge>
				</DashboardActionsProvider>
			</DashboardVariablesProvider>
		</DashboardTimeRangeWrapper>
	)
}

function HistoryPanelMount({ dashboardId, onClose }: { dashboardId: DashboardId; onClose: () => void }) {
	const [previewed, setPreviewed] = useAtom(previewedVersionAtom)
	const result = useDashboardVersions(dashboardId)

	const onPreview = (versionId: DashboardVersionId) => {
		if (!Result.isSuccess(result)) return
		const version = result.value.data.find((v) => v.id === versionId)
		if (!version) return
		setPreviewed({
			versionId: version.id,
			versionNumber: version.versionNumber,
			createdAt: version.createdAt,
			createdBy: version.createdBy,
		})
	}

	return (
		<DashboardHistoryPanel
			dashboardId={dashboardId}
			previewed={previewed}
			onPreview={onPreview}
			onClose={onClose}
		/>
	)
}

function WidgetPickerWithActions({
	open,
	onOpenChange,
	target,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Which grid the chosen widget lands in; `null` is the root canvas. */
	target: SectionTarget
}) {
	const { addWidget } = useDashboardActions()
	return (
		<WidgetPicker
			open={open}
			onOpenChange={onOpenChange}
			onSelect={(visualization, dataSource, display) =>
				addWidget(visualization, dataSource, display, target)
			}
		/>
	)
}
