import { cn } from "@maple/ui/lib/utils"
import {
	scrollAreaStyles,
	scrollAreaThumbStyles,
	scrollAreaViewportFadeStyles,
	scrollAreaViewportGutterStyles,
	scrollAreaViewportStyles,
	scrollBarStyles,
} from "@maple/ui/styles/ui/scroll-area"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** Base UI hides the viewport's native scrollbar with this class and an injected rule (styles.css). */
const DISABLE_SCROLLBAR = "base-ui-disable-scrollbar"

/** What Base UI measured for a vertically overflowing viewport (scrolled to the top). */
export type ScrollAreaOverflowY = Readonly<{ endPx: number; thumbHeightPx: number }>

/**
 * Base UI's overflow measurement, written straight onto a mounted viewport: the `--scroll-area-
 * overflow-y-*` variables the fade masks read and the root's `data-has-overflow-y` / edge flags.
 */
export const applyScrollOverflow = (viewport: HTMLElement): void => {
	const root = viewport.parentElement
	const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
	const start = Math.min(Math.max(viewport.scrollTop, 0), max)
	const end = max - start
	viewport.style.setProperty("--scroll-area-overflow-y-start", `${start}px`)
	viewport.style.setProperty("--scroll-area-overflow-y-end", `${end}px`)
	for (const element of [viewport, root]) {
		element?.toggleAttribute("data-has-overflow-y", max > 0)
		element?.toggleAttribute("data-overflow-y-start", start > 0)
		element?.toggleAttribute("data-overflow-y-end", end > 0)
	}
}

/** Base UI's `MIN_THUMB_SIZE`. */
const MIN_THUMB_SIZE = 16

/**
 * For a viewport rendered with `hasMeasuredScrollbar`: the thumb height Base UI computes and the
 * root's `data-hovering` while the pointer is over it, written onto the mounted elements.
 */
export const trackScrollbar = (viewport: HTMLElement): (() => void) => {
	const root = viewport.parentElement
	const scrollbar = root?.querySelector<HTMLElement>(':scope > [data-slot="scroll-area-scrollbar"]') ?? null
	const measure = () => {
		if (scrollbar === null || viewport.scrollHeight === 0) return
		const track = Math.min(scrollbar.offsetHeight, viewport.clientHeight)
		const thumb = Math.max(MIN_THUMB_SIZE, (track * viewport.clientHeight) / viewport.scrollHeight)
		scrollbar.style.setProperty("--scroll-area-thumb-height", `${thumb}px`)
		const max = viewport.scrollHeight - viewport.clientHeight
		scrollbar.toggleAttribute("data-has-overflow-y", max > 0)
		scrollbar.toggleAttribute("data-overflow-y-start", viewport.scrollTop > 0)
		scrollbar.toggleAttribute("data-overflow-y-end", max - viewport.scrollTop > 0)
	}
	const hover = (event: PointerEvent) => {
		const isOver = event.target instanceof Node && root?.contains(event.target) === true
		const targets = [root, scrollbar]
		targets.forEach((element) => element?.toggleAttribute("data-hovering", isOver))
	}
	const leave = () => {
		;[root, scrollbar].forEach((element) => element?.removeAttribute("data-hovering"))
	}
	measure()
	const observer = new ResizeObserver(measure)
	observer.observe(viewport)
	viewport.addEventListener("scroll", measure, { passive: true })
	root?.addEventListener("pointerenter", hover)
	root?.addEventListener("pointermove", hover)
	root?.addEventListener("pointerleave", leave)
	return () => {
		observer.disconnect()
		viewport.removeEventListener("scroll", measure)
		root?.removeEventListener("pointerenter", hover)
		root?.removeEventListener("pointermove", hover)
		root?.removeEventListener("pointerleave", leave)
	}
}

export type ScrollAreaOptions<Message = never> = Readonly<{
	className?: string
	scrollFade?: boolean
	scrollbarGutter?: boolean
	/** Base UI's `data-id` is `<root id>-viewport`. */
	idPrefix: string
	/** Renders the vertical scrollbar Base UI shows once content overflows. */
	overflowY?: ScrollAreaOverflowY
	/** Renders the scrollbar for a Mount to size and show (`trackScrollbar`), with no static state. */
	hasMeasuredScrollbar?: boolean
	/** Extra viewport attributes, e.g. a Mount that measures the overflow (`MeasureScrollOverflow`). */
	viewportAttributes?: ReadonlyArray<Attribute<Message>>
}>

const verticalScrollbar = <Message>(
	h: HtmlBuilder<Message>,
	idPrefix: string,
	overflowY: ScrollAreaOverflowY,
	state: ReadonlyArray<Attribute<Message>>,
): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class(scrollBarStyles),
			...state,
			h.DataAttribute("id", `${idPrefix}-scrollbar`),
			h.DataAttribute("orientation", "vertical"),
			h.DataAttribute("slot", "scroll-area-scrollbar"),
			h.Style({
				position: "absolute",
				"touch-action": "none",
				"user-select": "none",
				top: "0px",
				bottom: "var(--scroll-area-corner-height)",
				"inset-inline-end": "0px",
				"--scroll-area-thumb-height": `${overflowY.thumbHeightPx}px`,
			}),
		],
		[
			h.div(
				[
					h.Class(scrollAreaThumbStyles),
					h.DataAttribute("orientation", "vertical"),
					h.DataAttribute("slot", "scroll-area-thumb"),
					h.Style({
						height: "var(--scroll-area-thumb-height)",
						transform: "translate3d(0px, 0px, 0px)",
					}),
				],
				[],
			),
		],
	)

/**
 * `<ScrollArea>`: Base UI's root and viewport, plus the vertical scrollbar when `overflowY` says the
 * content overflows. The overflow values are passed in until a measuring Mount is needed.
 */
export const scrollArea = <Message>(
	h: HtmlBuilder<Message>,
	options: ScrollAreaOptions<Message>,
	children: ReadonlyArray<Html>,
): Html => {
	const { overflowY } = options
	const state =
		overflowY === undefined
			? []
			: [h.DataAttribute("has-overflow-y", ""), h.DataAttribute("overflow-y-end", "")]
	return h.div(
		[
			h.Class(cn(scrollAreaStyles, options.className)),
			...state,
			h.Role("presentation"),
			h.Style({
				position: "relative",
				"--scroll-area-corner-height": "0px",
				"--scroll-area-corner-width": "0px",
			}),
		],
		[
			h.div(
				[
					h.Class(
						`${cn(
							scrollAreaViewportStyles,
							options.scrollFade === true && scrollAreaViewportFadeStyles,
							options.scrollbarGutter === true && scrollAreaViewportGutterStyles,
						)} ${DISABLE_SCROLLBAR}`,
					),
					...state,
					h.DataAttribute("id", `${options.idPrefix}-viewport`),
					h.DataAttribute("slot", "scroll-area-viewport"),
					h.Role("presentation"),
					h.Style({
						overflow: "scroll",
						"--scroll-area-overflow-x-start": "0px",
						"--scroll-area-overflow-x-end": "0px",
						"--scroll-area-overflow-y-start": "0px",
						"--scroll-area-overflow-y-end": `${overflowY?.endPx ?? 0}px`,
					}),
					h.Tabindex(overflowY === undefined ? -1 : 0),
					...(options.viewportAttributes ?? []),
				],
				children,
			),
			...(overflowY !== undefined
				? [verticalScrollbar(h, options.idPrefix, overflowY, state)]
				: options.hasMeasuredScrollbar === true
					? [verticalScrollbar(h, options.idPrefix, { endPx: 0, thumbHeightPx: 0 }, [])]
					: []),
		],
	)
}
