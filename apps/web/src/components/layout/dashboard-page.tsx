import type * as React from "react"

import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import type { TimeRange } from "@/components/time-range-picker/types"
import type { TimePreset } from "@/lib/time-utils"

import { DashboardLayout, type BreadcrumbEntry, type PageGap, type PageWidth } from "./dashboard-layout"

/** A page whose data is windowed by the URL's `startTime`/`endTime`/`timePreset`. */
export interface PageTimeScope {
	/** The route's decoded search; only the window is read. */
	search: TimeRangeSearch
	/** The preset when the URL carries none ("12h" lists, "1h" detail pages). */
	defaultPreset: string
	onChange: (range: TimeRange, options?: { replace?: boolean }) => void
	/** The effective window, shown when the URL carries none. */
	startTime?: string
	endTime?: string
	presets?: ReadonlyArray<TimePreset>
	maxRangeSeconds?: number
}

export interface DashboardPageProps {
	breadcrumbs: ReadonlyArray<BreadcrumbEntry>
	/** Extra controls in the top bar, after the persistent cluster. */
	topbarActions?: React.ReactNode
	/** Header left side: a `DashboardLayout.Title`, view tabs, a status strip. */
	titleContent?: React.ReactNode
	/** Header right side, before the time controls. */
	headerActions?: React.ReactNode
	/** Replaces the generated `Header` outright (a `DetailHeader`, a skeleton). */
	header?: React.ReactNode
	/** Wires the URL window: refresh provider plus the time controls in the header. */
	time?: PageTimeScope
	/** Page tabs, pinned under the header. */
	tabs?: React.ReactNode
	/** Anything else pinned above the scroll area (a toolbar, a banner). */
	sticky?: React.ReactNode
	filters?: React.ReactNode
	filtersWidth?: string
	rightPanel?: React.ReactNode
	rightPanelTitle?: string
	rightPanelWidth?: string
	/** The body owns its scrolling (a transcript, a virtualized table): `Fill` instead of `Scroll`. */
	fill?: boolean
	width?: PageWidth
	gap?: PageGap
	/** Extra classes for the `Scroll` area (padding overrides). Ignored with `fill`. */
	scrollClassName?: string
	children: React.ReactNode
}

/**
 * The whole `DashboardLayout` tree for the common page: breadcrumbs, a sticky header
 * (optionally carrying the URL time window), tabs, filter and context rails, and the body.
 * Compose `DashboardLayout.*` by hand only for layouts this cannot express.
 */
export function DashboardPage({
	breadcrumbs,
	topbarActions,
	titleContent,
	headerActions,
	header,
	time,
	tabs,
	sticky,
	filters,
	filtersWidth,
	rightPanel,
	rightPanelTitle,
	rightPanelWidth,
	fill = false,
	width,
	gap,
	scrollClassName,
	children,
}: DashboardPageProps) {
	const timeControls = time ? (
		<TimeRangeHeaderControls
			search={time.search}
			startTime={time.startTime}
			endTime={time.endTime}
			defaultPreset={time.defaultPreset}
			onTimeChange={time.onChange}
			presets={time.presets}
			maxRangeSeconds={time.maxRangeSeconds}
		/>
	) : null
	const actions =
		headerActions && timeControls ? (
			<div className="flex flex-wrap items-center gap-2">
				{headerActions}
				{timeControls}
			</div>
		) : (
			(headerActions ?? timeControls)
		)
	const headerNode =
		header ??
		(titleContent || actions ? (
			<DashboardLayout.Header titleContent={titleContent}>{actions}</DashboardLayout.Header>
		) : null)
	const hasSticky = headerNode || tabs || sticky

	const page = (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={breadcrumbs}>{topbarActions}</DashboardLayout.Breadcrumbs>
			<DashboardLayout.Body>
				{filters ? (
					<DashboardLayout.Filters width={filtersWidth}>{filters}</DashboardLayout.Filters>
				) : null}
				<DashboardLayout.Content>
					{hasSticky ? (
						<DashboardLayout.Sticky>
							{headerNode}
							{tabs ? <DashboardLayout.Tabs>{tabs}</DashboardLayout.Tabs> : null}
							{sticky}
						</DashboardLayout.Sticky>
					) : null}
					{fill ? (
						<DashboardLayout.Fill>{children}</DashboardLayout.Fill>
					) : (
						<DashboardLayout.Scroll width={width} gap={gap} className={scrollClassName}>
							{children}
						</DashboardLayout.Scroll>
					)}
				</DashboardLayout.Content>
				{rightPanel ? (
					<DashboardLayout.RightPanel title={rightPanelTitle} width={rightPanelWidth}>
						{rightPanel}
					</DashboardLayout.RightPanel>
				) : null}
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)

	if (!time) return page
	return (
		<PageRefreshProvider timePreset={time.search.timePreset ?? time.defaultPreset}>
			{page}
		</PageRefreshProvider>
	)
}
