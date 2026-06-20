import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { cn } from "@maple/ui/utils"
import { isEditableTarget, isOverlayOpen } from "@/lib/keyboard"
import { ChartLegendSlotContext, type ChartLegendItem } from "@maple/ui/components/ui/chart"
import {
	GripDotsIcon,
	TrashIcon,
	PencilIcon,
	CopyIcon,
	DotsVerticalIcon,
	ChatBubbleSparkleIcon,
	BellIcon,
	MaximizeIcon,
} from "@/components/icons"
import { ChartExpandModal } from "@/components/dashboard-builder/widgets/chart-expand-modal"

import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@maple/ui/components/ui/card"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@maple/ui/components/ui/dropdown-menu"
import type { WidgetMode, WidgetDataState } from "@/components/dashboard-builder/types"
import { useWidgetActions } from "@/components/dashboard-builder/widgets/widget-actions-context"

interface WidgetShellProps {
	title: string
	mode: WidgetMode
	/**
	 * Action callbacks. When omitted, they fall back to the nearest
	 * `WidgetActionsProvider`; explicit props override context (used by the
	 * widget lab, which renders widgets outside a dashboard provider).
	 */
	onRemove?: () => void
	onClone?: () => void
	onConfigure?: () => void
	/** When set, a "Create alert" menu item is shown (in edit and view mode). */
	onCreateAlert?: () => void
	/** Headline stat rendered at the top-right of the card header. */
	headerValue?: ReactNode
	/** Summary stat rendered below the card content. */
	footer?: ReactNode
	contentClassName?: string
	/**
	 * When provided, a "maximize" button is shown in the header that opens a
	 * near-fullscreen modal rendering the result of this render-prop (typically
	 * the same chart at a larger size). Kept as a callback so the larger chart
	 * is only mounted while the modal is open.
	 */
	renderExpanded?: () => ReactNode
	children: ReactNode
}

export function WidgetShell({
	title,
	mode,
	onRemove,
	onClone,
	onConfigure,
	onCreateAlert,
	headerValue,
	footer,
	contentClassName,
	renderExpanded,
	children,
}: WidgetShellProps) {
	const ctx = useWidgetActions()
	const remove = onRemove ?? ctx?.remove
	const clone = onClone ?? ctx?.clone
	const configure = onConfigure ?? ctx?.configure
	const createAlert = onCreateAlert ?? ctx?.createAlert
	const isEditable = mode === "edit"
	// The menu is also shown in view mode when "Create alert" is available, so
	// alerts can be spun off a chart without entering dashboard edit mode.
	const showMenu = isEditable || createAlert != null
	const [menuOpen, setMenuOpen] = useState(false)
	const [expanded, setExpanded] = useState(false)
	const canExpand = renderExpanded != null
	const [legendItems, setLegendItems] = useState<ChartLegendItem[]>([])
	const legendSlot = useMemo(() => ({ setItems: setLegendItems }), [])

	// "F" opens the expand modal for the chart the mouse is currently over. The
	// listener is owned by the hovered shell (attached on mouse-enter, removed on
	// leave) so only that one widget responds — no shared hover registry needed.
	const [hovered, setHovered] = useState(false)
	const expandRef = useRef<() => void>(() => undefined)
	expandRef.current = () => {
		if (canExpand) setExpanded(true)
	}

	useEffect(() => {
		if (!hovered || !canExpand) return
		const handler = (e: KeyboardEvent) => {
			if (e.key !== "f" && e.key !== "F") return
			if (e.metaKey || e.ctrlKey || e.altKey) return
			if (isEditableTarget(e.target)) return
			if (isEditableTarget(document.activeElement)) return
			if (isOverlayOpen()) return
			e.preventDefault()
			e.stopPropagation()
			expandRef.current()
		}
		window.addEventListener("keydown", handler, { capture: true })
		return () => window.removeEventListener("keydown", handler, { capture: true })
	}, [hovered, canExpand])

	return (
		<Card
			className="group/card h-full flex flex-col"
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<CardHeader className="py-2.5 items-center">
				<div className="flex min-w-0 items-center gap-2">
					{isEditable && (
						<div className="widget-drag-handle cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground">
							<GripDotsIcon size={14} />
						</div>
					)}
					<CardTitle className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						{title}
					</CardTitle>
					{headerValue != null && (
						<div className="ml-auto shrink-0 font-mono font-semibold text-xs tabular-nums">
							{headerValue}
						</div>
					)}
					{legendItems.length >= 2 &&
						(() => {
							// Keep the header to a single row: show a few items, then a
							// "+N" chip (full list on hover) so a many-series legend can
							// never wrap and crowd the title.
							const MAX_HEADER_ITEMS = 5
							const visible = legendItems.slice(0, MAX_HEADER_ITEMS)
							const overflow = legendItems.length - visible.length
							return (
								<div className="flex min-w-0 flex-1 items-center justify-end gap-x-3 overflow-hidden">
									{visible.map((item) => (
										<span
											key={item.key}
											className="flex min-w-0 shrink items-center gap-1.5 text-[10px] text-muted-foreground"
										>
											<span
												className="size-2 shrink-0 rounded-[2px]"
												style={{ backgroundColor: item.color }}
											/>
											<span className="truncate">{item.label}</span>
										</span>
									))}
									{overflow > 0 && (
										<span
											className="shrink-0 text-[10px] text-muted-foreground"
											title={legendItems.map((i) => i.label).join(", ")}
										>
											+{overflow}
										</span>
									)}
								</div>
							)
						})()}
				</div>
				{(showMenu || canExpand) && (
					<CardAction
						// Pin to row 1 so the action centers against the title's row
						// rather than the header's full two-row span (whose row gap
						// would otherwise push the button off the title's center line).
						style={{ gridRow: "1" }}
						className={cn(
							"-my-1 flex items-center gap-0.5 self-center",
							!isEditable &&
								"opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100",
							!isEditable && (menuOpen || expanded) && "opacity-100",
						)}
					>
						{canExpand && (
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Expand chart"
								title="Expand"
								onClick={() => setExpanded(true)}
							>
								<MaximizeIcon size={14} />
							</Button>
						)}
						{showMenu && (
							<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
								<DropdownMenuTrigger
									render={
										<Button variant="ghost" size="icon-xs">
											<DotsVerticalIcon size={14} />
										</Button>
									}
								/>
								<DropdownMenuContent align="end">
									{isEditable && configure && (
										<DropdownMenuItem onClick={configure}>
											<PencilIcon size={14} />
											Edit
										</DropdownMenuItem>
									)}
									{isEditable && clone && (
										<DropdownMenuItem onClick={clone}>
											<CopyIcon size={14} />
											Clone
										</DropdownMenuItem>
									)}
									{createAlert && (
										<DropdownMenuItem onClick={createAlert}>
											<BellIcon size={14} />
											Create alert
										</DropdownMenuItem>
									)}
									{isEditable && remove && (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuItem variant="destructive" onClick={remove}>
												<TrashIcon size={14} />
												Delete
											</DropdownMenuItem>
										</>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</CardAction>
				)}
			</CardHeader>
			<CardContent className={contentClassName ?? "flex-1 min-h-0 p-2"}>
				<ChartLegendSlotContext.Provider value={legendSlot}>
					{children}
				</ChartLegendSlotContext.Provider>
			</CardContent>
			{footer != null && (
				<div className="shrink-0 px-3 pb-2.5 text-[11px] text-muted-foreground">{footer}</div>
			)}
			{canExpand && (
				<ChartExpandModal open={expanded} onOpenChange={setExpanded} title={title}>
					{renderExpanded()}
				</ChartExpandModal>
			)}
		</Card>
	)
}

export function ReadonlyWidgetShell(props: Omit<WidgetShellProps, "mode">) {
	return <WidgetShell {...props} mode="view" />
}

interface WidgetFrameProps {
	title: string
	dataState: WidgetDataState
	mode: WidgetMode
	/**
	 * Action callbacks. When omitted, they fall back to the nearest
	 * `WidgetActionsProvider`; explicit props override context (used by the
	 * widget lab, which renders widgets outside a dashboard provider).
	 */
	onRemove?: () => void
	onClone?: () => void
	onConfigure?: () => void
	onCreateAlert?: () => void
	onFix?: () => void
	contentClassName?: string
	/** See `WidgetShellProps.renderExpanded`. */
	renderExpanded?: () => ReactNode
	loadingSkeleton: ReactNode
	children: ReactNode
}

export function WidgetFrame({
	title,
	dataState,
	mode,
	onRemove,
	onClone,
	onConfigure,
	onCreateAlert,
	onFix,
	contentClassName,
	renderExpanded,
	loadingSkeleton,
	children,
}: WidgetFrameProps) {
	// `WidgetShell` resolves the menu actions against context itself; `fix`
	// drives the inline error CTA below, so it is resolved here too.
	const ctx = useWidgetActions()
	const fix = onFix ?? ctx?.fix

	return (
		<WidgetShell
			title={title}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			onCreateAlert={onCreateAlert}
			contentClassName={contentClassName}
			renderExpanded={dataState.status === "ready" ? renderExpanded : undefined}
		>
			{dataState.status === "loading" ? (
				loadingSkeleton
			) : dataState.status === "error" ? (
				dataState.message === "No query data found in selected time range" ? (
					<div className="flex items-center justify-center h-full">
						<span className="text-xs text-muted-foreground">No data in selected time range</span>
					</div>
				) : (
					<div className="flex items-center justify-center h-full flex-col gap-1.5 px-3">
						<span className="text-xs font-medium text-destructive">
							{dataState.title ?? "Unable to load"}
						</span>
						{dataState.message && (
							<span className="text-[10px] text-destructive/70 max-w-full text-center line-clamp-2">
								{dataState.message}
							</span>
						)}
						{fix && dataState.kind === "decode" && (
							<Button
								variant="outline"
								size="xs"
								onClick={fix}
								className="mt-1 h-6 gap-1 text-[10px]"
							>
								<ChatBubbleSparkleIcon size={12} />
								Fix with AI
							</Button>
						)}
					</div>
				)
			) : (
				children
			)}
		</WidgetShell>
	)
}
