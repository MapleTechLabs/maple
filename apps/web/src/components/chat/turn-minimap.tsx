import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react"

import { cn } from "@maple/ui/lib/utils"
import { Button } from "@maple/ui/components/ui/button"
import { useMessageScroller, useMessageScrollerVisibility } from "@maple/ui/components/ui/message-scroller"
import { ChevronDownIcon, ChevronUpIcon } from "@/components/icons"
import type { TranscriptRow } from "./transcript-rows"
import {
	deriveTurnMinimap,
	minimapHasPersistentGutter,
	minimapHeightStyle,
	minimapHitStripWidth,
	minimapIndexFromPointer,
	minimapInteractiveWidth,
	minimapPreviewTranslate,
	minimapTopPercent,
	resolveCurrentTurnIndex,
	TURN_MINIMAP_MIN_ITEMS,
	type TurnMinimapItem,
} from "./turn-minimap-logic"

/**
 * A rail of one marker per human turn, down the transcript's inline gutter.
 *
 * It answers "where am I, and what happened before this" without scrolling: the marker
 * for every turn on screen is lit, running the pointer down the rail previews each turn's
 * question and the reply it got, and a click jumps there. Long agent threads are the case
 * — a dozen turns of tool bursts read as an undifferentiated column otherwise.
 *
 * Pointer-fine only. There is no gutter to hover on a touch device, and the strip would
 * fight the transcript for the same swipes.
 */
export function TurnMinimap({ rows }: { rows: readonly TranscriptRow[] }) {
	const { items, turnByRowId } = useMemo(() => deriveTurnMinimap(rows), [rows])
	const { visibleMessageIds } = useMessageScrollerVisibility()
	const { scrollToMessage } = useMessageScroller()

	const [railElement, setRailElement] = useState<HTMLDivElement | null>(null)
	const [hasPersistentGutter, setHasPersistentGutter] = useState(false)
	const [hitStripWidth, setHitStripWidth] = useState(0)
	const [activeIndex, setActiveIndex] = useState<number | null>(null)

	// The rail spans the scroller, so its own box is the width the transcript is centred in.
	useEffect(() => {
		if (!railElement) return
		const measure = () => {
			const width = railElement.getBoundingClientRect().width
			setHasPersistentGutter(minimapHasPersistentGutter(width))
			setHitStripWidth(minimapHitStripWidth(width))
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(railElement)
		return () => observer.disconnect()
	}, [railElement])

	const currentIndex = resolveCurrentTurnIndex(visibleMessageIds, turnByRowId)
	const visibleTurns = useMemo(() => {
		const turns = new Set<number>()
		for (const id of visibleMessageIds) {
			const index = turnByRowId.get(id)
			if (index !== undefined) turns.add(index)
		}
		return turns
	}, [visibleMessageIds, turnByRowId])

	const resolvedActiveIndex = activeIndex !== null && activeIndex < items.length ? activeIndex : null
	const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null)
	const previousItem = currentIndex === null ? null : (items[currentIndex - 1] ?? null)
	const nextItem = currentIndex === null ? null : (items[currentIndex + 1] ?? null)

	const select = useCallback(
		(item: TurnMinimapItem) => {
			scrollToMessage(item.id, { align: "start", behavior: "smooth" })
		},
		[scrollToMessage],
	)

	const indexFromPointer = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			const rect = event.currentTarget.getBoundingClientRect()
			return minimapIndexFromPointer({
				itemCount: items.length,
				railTop: rect.top,
				railHeight: rect.height,
				pointerY: event.clientY,
			})
		},
		[items.length],
	)

	const moveActiveIndex = useCallback(
		(delta: number) => {
			setActiveIndex((current) =>
				Math.max(0, Math.min(items.length - 1, (current ?? currentIndex ?? 0) + delta)),
			)
		},
		[items.length, currentIndex],
	)

	if (items.length < TURN_MINIMAP_MIN_ITEMS) return null

	return (
		<div
			ref={setRailElement}
			className={cn(
				"pointer-events-none absolute inset-y-0 start-0 z-30 hidden w-full [@media(pointer:fine)]:block",
				hasPersistentGutter
					? "opacity-100"
					: "opacity-0 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100",
			)}
			data-slot="turn-minimap"
		>
			<div
				className={cn(
					"absolute top-1/2 start-3 -translate-y-1/2 select-none",
					hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
				)}
				style={{
					height: minimapHeightStyle(items.length),
					width: minimapInteractiveWidth(hitStripWidth, activeItem !== null),
				}}
			>
				<TurnMinimapStep
					direction="previous"
					disabled={previousItem === null}
					onClick={() => {
						if (previousItem) select(previousItem)
					}}
				/>
				<button
					type="button"
					aria-label={
						activeItem
							? `Jump to turn: ${activeItem.userText ?? "user message"}`
							: "Jump to a turn"
					}
					className="absolute inset-y-0 start-0 w-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
					onBlur={() => setActiveIndex(null)}
					onFocus={() => setActiveIndex((current) => current ?? currentIndex ?? 0)}
					onMouseLeave={() => setActiveIndex(null)}
					onMouseMove={(event) => setActiveIndex(indexFromPointer(event))}
					// The rail is a navigation control, not text: a drag on it should not
					// start a selection that the preview then inherits.
					onMouseDown={(event) => {
						if (targetsPreview(event.target)) return
						event.preventDefault()
					}}
					onClick={(event) => {
						if (targetsPreview(event.target)) return
						const index = indexFromPointer(event)
						const item = index === null ? null : (items[index] ?? null)
						if (item) select(item)
						event.currentTarget.blur()
					}}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown") {
							event.preventDefault()
							moveActiveIndex(1)
						} else if (event.key === "ArrowUp") {
							event.preventDefault()
							moveActiveIndex(-1)
						} else if (event.key === "Home") {
							event.preventDefault()
							setActiveIndex(0)
						} else if (event.key === "End") {
							event.preventDefault()
							setActiveIndex(items.length - 1)
						} else if (event.key === "Enter" || event.key === " ") {
							event.preventDefault()
							if (activeItem) select(activeItem)
						}
					}}
				>
					<div className="absolute top-0 start-3 h-full w-px bg-border/20" />
					{items.map((item, index) => {
						const distance =
							resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex)
						return (
							<span
								key={item.id}
								aria-hidden
								className={cn(
									"pointer-events-none absolute start-0 h-0.5 -translate-y-1/2 rounded-full transition-[background-color,width] duration-150",
									visibleTurns.has(index) ? "bg-foreground/80" : "bg-muted-foreground/35",
									distance === 0
										? "w-6 bg-muted-foreground/75"
										: distance === 1
											? "w-4"
											: distance === 2
												? "w-2.5"
												: "w-2",
								)}
								style={{ top: `${minimapTopPercent(index, items.length)}%` }}
							/>
						)
					})}
					{activeItem ? (
						<span
							className="pointer-events-auto absolute start-8 w-80 cursor-text select-text"
							data-turn-minimap-preview
							onMouseMove={(event) => event.stopPropagation()}
							style={{
								top: `${minimapTopPercent(resolvedActiveIndex ?? 0, items.length)}%`,
								transform: `translateY(${minimapPreviewTranslate(resolvedActiveIndex ?? 0, items.length)})`,
							}}
						>
							<span className="block rounded-lg border border-border bg-popover p-3 text-start text-popover-foreground shadow-md">
								<span className="block truncate text-sm font-medium leading-5">
									{activeItem.userText ?? "User message"}
								</span>
								{activeItem.assistantText ? (
									<span className="mt-1 line-clamp-3 block text-sm leading-5 text-muted-foreground">
										{activeItem.assistantText}
									</span>
								) : null}
							</span>
						</span>
					) : null}
				</button>
				<TurnMinimapStep
					direction="next"
					disabled={nextItem === null}
					onClick={() => {
						if (nextItem) select(nextItem)
					}}
				/>
			</div>
		</div>
	)
}

/** The preview is selectable text; pointer events that land in it are not rail clicks. */
function targetsPreview(target: EventTarget): boolean {
	return target instanceof Element && target.closest("[data-turn-minimap-preview]") !== null
}

function TurnMinimapStep({
	direction,
	disabled,
	onClick,
}: {
	direction: "previous" | "next"
	disabled: boolean
	onClick: () => void
}) {
	const previous = direction === "previous"
	const label = previous ? "Previous turn" : "Next turn"
	const Icon = previous ? ChevronUpIcon : ChevronDownIcon

	return (
		<span
			className={cn(
				"pointer-events-auto absolute start-0 z-10 inline-flex opacity-0 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100",
				previous ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)]",
			)}
		>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				aria-label={label}
				disabled={disabled}
				onClick={onClick}
			>
				<Icon className="size-3.5" />
			</Button>
		</span>
	)
}
