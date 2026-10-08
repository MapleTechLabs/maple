import {
	memo,
	useCallback,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	type ComponentType,
	type CSSProperties,
	type ReactNode,
	type RefObject,
} from "react"
import type { SectionMembership } from "@maple/widgets/dashboard"
import {
	changedItems,
	itemRect,
	normalizeLayout,
	type GridGeometry,
	type GridItem,
	type Layout,
	type PixelRect,
} from "@maple/grid-engine"
import { cn } from "@maple/ui/lib/utils"

import {
	GRID_ROW_HEIGHT,
	projectLayout,
	type GridTier,
	type PlacedWidget,
} from "@/components/dashboard-builder/canvas/grid-breakpoints"
import { GridHandleContext } from "@/components/dashboard-builder/canvas/grid-handle-context"
import { useGridInteraction, type Drop } from "@/components/dashboard-builder/canvas/use-grid-interaction"
import { useDashboardActionsOptional } from "@/components/dashboard-builder/dashboard-actions-context"

/** What the canvas needs of a widget: somewhere to put it, and which group it's in. */
export interface CanvasWidget extends PlacedWidget, SectionMembership {}

/**
 * How one widget draws itself.
 *
 * A component type rather than a `(widget) => ReactNode` callback: renderers
 * call hooks, and a function prop invoked inline would splice them into the
 * grid child's hook slot. Mirrors `visualizationFor`, which already returns a
 * component.
 */
export type WidgetRendererComponent<W> = ComponentType<{ widget: W }>

export type LayoutCommit = Array<{ i: string; x: number; y: number; w: number; h: number }>

interface DashboardGridProps<W extends CanvasWidget> {
	widgets: ReadonlyArray<W>
	/** Measured container width in px. The caller owns measurement. */
	width: number
	tier: GridTier
	editable: boolean
	/**
	 * Required, never defaulted: a default cannot type-check against an
	 * arbitrary `W`, and naming the renderer at each mount point is what stops a
	 * read-only surface silently inheriting the authed data path.
	 */
	renderWidget: WidgetRendererComponent<W>
	/**
	 * Where a finished drag or resize goes: only the widgets whose box changed.
	 * Defaults to the dashboard store through `DashboardActionsProvider`.
	 */
	onLayoutCommit?: (layouts: LayoutCommit) => void
}

const GLIDE: KeyframeAnimationOptions = { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" }

function prefersReducedMotion(): boolean {
	return (
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	)
}

/** Placement in CSS Grid lines. The browser does the layout; no measured width needed. */
function gridArea(item: GridItem): CSSProperties {
	return { gridColumn: `${item.x + 1} / span ${item.w}`, gridRow: `${item.y + 1} / span ${item.h}` }
}

/** How far a running glide currently draws the element from its box at `to`. */
function glideOffset(element: HTMLElement, to: PixelRect) {
	const container = element.parentElement?.getBoundingClientRect()
	const drawn = element.getBoundingClientRect()
	if (!container) return { left: 0, top: 0 }
	return { left: drawn.left - container.left - to.left, top: drawn.top - container.top - to.top }
}

/**
 * Animate an element from where it was drawn to its new grid cell (FLIP). Only
 * runs while someone is rearranging: a tier change or a store update snaps.
 */
function useGlide(
	ref: RefObject<HTMLDivElement | null>,
	item: GridItem,
	geometry: GridGeometry,
	gliding: RefObject<boolean>,
	dropFrom: Drop | null,
	/** Carried by the pointer: its transform is the pointer's, never a glide's. */
	carried: boolean,
) {
	const previous = useRef(item)
	const consumedDrop = useRef<Drop | null>(null)
	useLayoutEffect(() => {
		const before = previous.current
		previous.current = item
		// A drop animates once. The store echoing the dropped layout back, or a
		// later resize, re-runs this with the same `dropFrom`; that is not a drop.
		const freshDrop = dropFrom !== null && dropFrom !== consumedDrop.current ? dropFrom : null
		if (freshDrop) consumedDrop.current = freshDrop
		const element = ref.current
		if (!element || carried || prefersReducedMotion()) return
		// Same box: a store echo or a re-projection hands over new objects for
		// tiles that did not move.
		const moved = before.x !== item.x || before.y !== item.y
		if (!freshDrop && (!moved || !gliding.current)) return

		const to = itemRect(geometry, item)
		const from = freshDrop ?? itemRect(geometry, before)
		const running = element.getAnimations()
		// Mid-glide: start from where it is drawn right now, not where it was
		// headed, or a quick second move jumps.
		const drift = !freshDrop && running.length > 0 ? glideOffset(element, to) : { left: 0, top: 0 }
		for (const animation of running) animation.cancel()
		const dx = from.left + drift.left - to.left
		const dy = from.top + drift.top - to.top
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
		element.animate(
			[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
			GLIDE,
		)
	}, [ref, item, geometry, gliding, dropFrom, carried])
}

interface GridCellProps {
	id: string
	item: GridItem
	/** The widget's rendered element, identity-stable so moving the cell never re-renders it. */
	content: ReactNode
	editable: boolean
	/** Set while a pointer drag carries this cell: its box when picked up. */
	lifted: PixelRect | null
	/** Picked up from the keyboard. */
	selected: boolean
	dropFrom: Drop | null
	geometry: GridGeometry
	gliding: RefObject<boolean>
}

const GridCell = memo(function GridCell({
	id,
	item,
	content,
	editable,
	lifted,
	selected,
	dropFrom,
	geometry,
	gliding,
}: GridCellProps) {
	const ref = useRef<HTMLDivElement>(null)
	useGlide(ref, item, geometry, gliding, dropFrom, lifted !== null)

	// A lifted cell leaves the grid flow and is drawn where it was picked up;
	// the pointer moves it from there with a transform, outside React.
	const style: CSSProperties = lifted
		? {
				position: "absolute",
				left: lifted.left,
				top: lifted.top,
				width: lifted.width,
				height: lifted.height,
			}
		: { position: "relative", minWidth: 0, ...gridArea(item) }

	return (
		<div
			ref={ref}
			data-grid-item={id}
			data-grid-box={`${item.x},${item.y},${item.w},${item.h}`}
			className={cn(
				"group/cell",
				lifted && "z-20 opacity-90 will-change-transform",
				selected && "z-10 rounded-lg outline-2 outline-offset-2 outline-primary",
			)}
			style={style}
		>
			{content}
			{editable && (
				<div
					data-grid-resize-handle=""
					aria-hidden
					className="absolute right-0 bottom-0 size-5 cursor-se-resize touch-none opacity-0 transition-opacity group-hover/cell:opacity-100 group-[.is-layout-locked]/canvas:hidden after:absolute after:right-1 after:bottom-1 after:size-1.5 after:border-r-2 after:border-b-2 after:border-muted-foreground/60"
				/>
			)}
		</div>
	)
})

/** Where the carried tile will land. */
function Placeholder({
	item,
	geometry,
	gliding,
}: {
	item: GridItem
	geometry: GridGeometry
	gliding: RefObject<boolean>
}) {
	const ref = useRef<HTMLDivElement>(null)
	useGlide(ref, item, geometry, gliding, null, false)
	return (
		<div
			ref={ref}
			aria-hidden
			data-grid-placeholder=""
			className="rounded-lg border border-dashed border-primary/60 bg-primary/5"
			style={gridArea(item)}
		/>
	)
}

/**
 * One grid over one container's widgets: native CSS Grid placement plus the
 * pointer and keyboard rearranging in `useGridInteraction`.
 *
 * Deliberately measurement-free: a sectioned board renders several of these, and
 * they must all agree on the same tier or a group could decide it is on a
 * narrower breakpoint than its neighbour. The parent measures once and passes
 * `width`/`tier` down. Placement itself never needs the width (CSS Grid does
 * it); only turning pointer positions into cells does.
 *
 * Every widget's `layout.x/y` is relative to *this* grid, so each instance is an
 * independent coordinate space starting at (0, 0).
 *
 * Generic over the widget because the read-only surfaces render a redacted
 * widget whose data source cannot inhabit the stored union. The type parameter
 * carries that difference; nothing here needs a cast.
 */
export function DashboardGrid<W extends CanvasWidget>({
	widgets,
	width,
	tier,
	editable,
	renderWidget: Renderer,
	onLayoutCommit,
}: DashboardGridProps<W>) {
	// Optional: a share link and a full-screen board mount this grid with no
	// store behind them. They are never editable, so there is nothing to persist.
	const actions = useDashboardActionsOptional()
	const commit = onLayoutCommit ?? actions?.updateWidgetLayouts

	const stored = useMemo(() => projectLayout(widgets, tier), [widgets, tier])
	// What is drawn: the stored boxes clamped into the grid and, on the authored
	// tier, packed upward. Derived tiers are already packed rows.
	const layout = useMemo(
		() => normalizeLayout(stored, tier.cols, tier.canonical ? "vertical" : "none"),
		[stored, tier],
	)
	const geometry = useMemo<GridGeometry>(
		() => ({
			width,
			cols: tier.cols,
			rowHeight: GRID_ROW_HEIGHT,
			gap: tier.margin,
			// The gutter belongs between tiles, not around them: the surrounding
			// layout owns the outer padding, so the first column sits flush with
			// section headers and page titles. Vertically the gap stays, so the
			// space under a section header is unchanged.
			padding: [0, tier.margin[1]],
		}),
		[width, tier],
	)

	// Persist only what the user changed, against what is stored rather than
	// what was drawn, so a board that needed packing is saved packed.
	const handleCommit = useCallback(
		(next: Layout) => {
			const changed = changedItems(stored, next)
			if (changed.length > 0) commit?.(changed.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })))
		},
		[stored, commit],
	)

	const { shown, active, drop, announcement, gliding, ghostRef, containerProps } = useGridInteraction({
		layout,
		geometry,
		enabled: editable,
		onCommit: handleCommit,
	})

	// One element per widget, rebuilt only when the widgets change. Handing a
	// cell the same element is what lets React skip the widget entirely when
	// only the cell's position changed.
	const contents = useMemo(
		() => new Map(widgets.map((widget) => [widget.id, <Renderer key={widget.id} widget={widget} />])),
		[widgets, Renderer],
	)
	const byId = useMemo(() => new Map(shown.map((item) => [item.i, item])), [shown])
	const instructionsId = useId()
	const activeItem = active ? byId.get(active.id) : undefined

	return (
		<GridHandleContext value={editable ? instructionsId : undefined}>
			<div
				{...containerProps}
				data-dashboard-grid=""
				style={{
					display: "grid",
					position: "relative",
					gridTemplateColumns: `repeat(${tier.cols}, minmax(0, 1fr))`,
					gridAutoRows: `${GRID_ROW_HEIGHT}px`,
					columnGap: tier.margin[0],
					rowGap: tier.margin[1],
					paddingBlock: tier.margin[1],
				}}
			>
				{widgets.map((widget) => {
					const item = byId.get(widget.id)
					if (!item) return null
					return (
						<GridCell
							key={widget.id}
							id={widget.id}
							item={item}
							content={contents.get(widget.id)}
							editable={editable}
							lifted={active?.kind === "drag" && active.id === widget.id ? active.rect : null}
							selected={active?.kind === "keyboard" && active.id === widget.id}
							dropFrom={drop?.id === widget.id ? drop : null}
							geometry={geometry}
							gliding={gliding}
						/>
					)
				})}
				{active?.kind === "drag" && activeItem && (
					<Placeholder item={activeItem} geometry={geometry} gliding={gliding} />
				)}
				{active?.kind === "resize" && (
					<div
						ref={ghostRef}
						aria-hidden
						className="pointer-events-none absolute z-20 rounded-lg border-2 border-dashed border-primary/60"
						style={{
							left: active.rect.left,
							top: active.rect.top,
							width: active.rect.width,
							height: active.rect.height,
						}}
					/>
				)}
				{editable && (
					<>
						<p id={instructionsId} hidden>
							Press Space to pick up. Arrow keys move, Shift and arrow keys resize, Space drops,
							Escape cancels.
						</p>
						<output aria-live="polite" className="sr-only">
							{announcement}
						</output>
					</>
				)}
			</div>
		</GridHandleContext>
	)
}
