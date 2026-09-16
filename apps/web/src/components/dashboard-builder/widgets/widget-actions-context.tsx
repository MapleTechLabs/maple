import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"

import type { SectionTarget } from "@maple/domain/http"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import type { DashboardSection, DashboardWidget, WidgetDataState } from "@/components/dashboard-builder/types"
import {
	encodeWidgetFixContextToSearchParam,
	type WidgetFixContext,
} from "@/components/chat/widget-fix-context"
import { encodeAlertChartToSearchParam } from "@/lib/alerts/widget-chart-param"
import { dataSourceRawSql, isQueryDataSource } from "@maple/widgets/dashboard"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { dashboardSharesAtom, type ShareRecord } from "@/components/dashboard-builder/toolbar/dashboard-shares"
import { EmbedWidgetDialog } from "@/components/dashboard-builder/toolbar/embed-widget-dialog"
import { unsupportedShareWidgets } from "@/components/dashboard-builder/toolbar/share-support"

export interface WidgetActions {
	remove?: () => void
	clone?: () => void
	configure?: () => void
	createAlert?: () => void
	fix?: () => void
	/**
	 * Opens the embed dialog for just this widget. `disabledReason` is set when
	 * the item is shown but cannot be used — the board is not public, or the
	 * widget is a kind a share cannot render.
	 */
	embed?: { open: () => void; disabledReason?: string }
	/**
	 * Pulls just this tile back to the widest window its query kind supports.
	 * Present only while the tile is blocked on a `range` error; local to the
	 * session, so it works on read-only dashboards too.
	 */
	narrowRange?: () => void
	/** Label for `narrowRange`, e.g. "Show last 7 days". */
	narrowRangeLabel?: string
	/**
	 * Re-home the widget into a group, or `null` for the root canvas. Present
	 * only in edit mode on a board that actually has groups — separate grids
	 * can't share a drag context, so this menu is how a tile changes group.
	 */
	moveToSection?: (target: SectionTarget) => void
	/** Destinations for `moveToSection`, in board order. */
	moveTargets?: DashboardSection[]
	/** Where the widget currently lives, so its own container reads as disabled. */
	moveCurrent?: SectionTarget
}

const WidgetActionsContext = createContext<WidgetActions | null>(null)

/**
 * Returns the widget actions provided by the nearest provider, or `null` when
 * rendered outside one (the template preview, which has no actions at all).
 */
export function useWidgetActions(): WidgetActions | null {
	return use(WidgetActionsContext)
}

/**
 * Supplies an explicit action set, for callers that render widgets outside a
 * dashboard — the widget lab, whose actions are console stubs. Widget renderers
 * take no action props; this is how you give them any.
 */
export function WidgetActionsScope({ actions, children }: { actions: WidgetActions; children: ReactNode }) {
	return <WidgetActionsContext value={actions}>{children}</WidgetActionsContext>
}

interface WidgetActionsProviderProps {
	widget: DashboardWidget
	dataState: WidgetDataState
	/** Supplied by `useWidgetData` when the tile is blocked on its range cap. */
	narrowRange?: () => void
	narrowRangeLabel?: string
	children: ReactNode
}

/**
 * Derives a single widget's action callbacks from the dashboard-level
 * `DashboardActionsContext` and exposes them via `WidgetActionsContext`. This
 * keeps the per-widget action wiring out of the canvas renderer and out of the
 * widget components' prop interfaces.
 */
export function WidgetActionsProvider({
	widget,
	dataState,
	narrowRange,
	narrowRangeLabel,
	children,
}: WidgetActionsProviderProps) {
	const {
		readOnly,
		removeWidget,
		cloneWidget,
		configureWidget,
		dashboardId,
		sections,
		moveWidgetToSection,
	} = useDashboardActions()
	const navigate = useNavigate()
	const [embedOpen, setEmbedOpen] = useState(false)
	const openEmbed = useCallback(() => setEmbedOpen(true), [])
	const embed = useWidgetEmbed(dashboardId, widget, openEmbed)

	const errorTitle = dataState.status === "error" ? (dataState.title ?? null) : null
	const errorMessage = dataState.status === "error" ? (dataState.message ?? null) : null
	const errorKind = dataState.status === "error" ? dataState.kind : undefined

	const actions = useMemo<WidgetActions>(() => {
		const remove = () => removeWidget(widget.id)

		const clone = readOnly ? undefined : () => cloneWidget(widget.id)
		const configure = readOnly ? undefined : () => configureWidget(widget.id)

		// "Create alert" is offered for query-driven charts; the alert builder
		// warns when chart-only features need review. Read structurally rather
		// than by endpoint name so the action survives the v2 -> v3 data-source
		// flip — an endpoint list would just make it disappear silently.
		const alertable = isQueryDataSource(widget.dataSource) || dataSourceRawSql(widget.dataSource) !== null
		const createAlert =
			dashboardId && alertable
				? () => {
						// Carry the live widget (optimistic builder state) so the alert
						// page prefills without racing the dashboard autosave; the
						// id pair stays as the lookup fallback for oversized payloads.
						const chart = encodeAlertChartToSearchParam({
							dashboardId,
							widget: {
								id: widget.id,
								visualization: widget.visualization,
								// The whole data source rather than three hand-picked fields:
								// the prefill reads it through the version-agnostic accessors,
								// and a field list here would have to grow with every v3 arm.
								dataSource: widget.dataSource,
								display: { title: widget.display.title },
							},
						})
						navigate({
							to: "/alerts/create",
							search: {
								dashboardId,
								widgetId: widget.id,
								...(chart ? { chart } : undefined),
							},
						})
					}
				: undefined

		const fix =
			dashboardId && errorKind === "decode"
				? () => {
						const ctx: WidgetFixContext = {
							dashboardId,
							widgetId: widget.id,
							widgetTitle: widget.display.title ?? "Untitled",
							widgetJson: JSON.stringify(widget),
							errorTitle,
							errorMessage,
						}
						navigate({
							to: "/chat",
							search: {
								mode: "widget-fix",
								widget: encodeWidgetFixContextToSearchParam(ctx),
							},
						})
					}
				: undefined

		// Offered only when there is somewhere to move to: on a board with no
		// groups the submenu would list nothing but "Ungrouped", which is where
		// the widget already is.
		const canMove = !readOnly && sections.length > 0
		const moveToSection = canMove
			? (target: SectionTarget) => moveWidgetToSection(widget.id, target)
			: undefined

		return {
			remove,
			clone,
			configure,
			createAlert,
			fix,
			embed,
			narrowRange,
			narrowRangeLabel,
			...(moveToSection
				? {
						moveToSection,
						moveTargets: sections,
						moveCurrent:
							widget.sectionId !== undefined && widget.tabId !== undefined
								? { sectionId: widget.sectionId, tabId: widget.tabId }
								: null,
					}
				: undefined),
		}
	}, [
		widget,
		readOnly,
		removeWidget,
		cloneWidget,
		configureWidget,
		sections,
		moveWidgetToSection,
		dashboardId,
		errorKind,
		errorTitle,
		errorMessage,
		navigate,
		embed,
		narrowRange,
		narrowRangeLabel,
	])

	return (
		<WidgetActionsContext value={actions}>
			{children}
			{embedOpen ? (
				<EmbedWidgetDialog
					dashboardId={dashboardId}
					widgetId={widget.id}
					open={embedOpen}
					onOpenChange={setEmbedOpen}
				/>
			) : null}
		</WidgetActionsContext>
	)
}

/**
 * "Embed chart" for one widget.
 *
 * Offered only on a public board, mirroring the server: a chart link resolves
 * only while its board is shared, capped at the board's mode.
 */
function useWidgetEmbed(
	dashboardId: string,
	widget: DashboardWidget,
	open: () => void,
): WidgetActions["embed"] {
	const sharesAtom = useMemo(() => dashboardSharesAtom(dashboardId), [dashboardId])
	const sharesResult = useAtomValue(sharesAtom)

	const boardPublic =
		Result.isSuccess(sharesResult) &&
		(sharesResult.value as ReadonlyArray<ShareRecord>).some(
			(share) => share.widgetId === undefined && share.mode === "public",
		)
	const supported = unsupportedShareWidgets([widget]).length === 0

	return useMemo(() => {
		const disabledReason = !boardPublic
			? "Make this dashboard public to embed its charts"
			: !supported
				? "This widget can't be shown in shared views"
				: undefined
		return { open, disabledReason }
	}, [open, boardPublic, supported])
}
