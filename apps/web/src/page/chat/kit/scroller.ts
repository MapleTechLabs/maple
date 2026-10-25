import { Effect, Schema } from "effect"
import { Mount } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

// `MessageScroller` (`@shadcn/react/message-scroller`, `autoScroll`, `defaultScrollPosition="end"`),
// its scrolling half: open at the end and follow it; a new user turn is anchored near the top (a
// spacer below the thread makes room) with 64 px of the previous turn peeking above, and held there
// while the reply streams; a wheel, touch or key scroll frees it. The jump button shows while the
// end is out of view. Pure DOM bookkeeping on the viewport, so it lives in a Mount.

export const ScrollerMessage = defineMessageUnion({ CompletedMountScroller: {} })
export const CompletedMountScroller = ScrollerMessage.CompletedMountScroller

/** Asks the scroller around the target to bring a message to the top (`scrollToMessage`). */
export const SCROLL_TO_MESSAGE = "maple:scroll-to-message"
const EDGE_THRESHOLD = 8
const PREVIOUS_PEEK = 64
const HALF_PIXEL = 0.5
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "])

type Mode = "following-bottom" | "anchored-to-message" | "settling-jump" | "free-scrolling"

const px = (value: string): number => {
	const parsed = Number.parseFloat(value)
	return Number.isFinite(parsed) ? parsed : 0
}

/** Wires one scroller; returns its teardown. Mutable locals are the DOM glue's own bookkeeping. */
const attach = (root: Element, focusMessageId: string | null): (() => void) => {
	const viewport = root.querySelector("[data-slot=message-scroller-viewport]")
	const content = root.querySelector("[data-slot=message-scroller-content]")
	const button = root.querySelector("[data-slot=message-scroller-button]")
	if (!(viewport instanceof HTMLElement) || !(content instanceof HTMLElement)) return () => {}
	// Read each time: the element is the view's, and a re-render may replace it.
	const spacerOf = (): HTMLElement | null => {
		const found = content.querySelector(":scope > [data-message-scroller-spacer]")
		return found instanceof HTMLElement ? found : null
	}
	let mode: Mode = "following-bottom"
	let anchored: HTMLElement | null = null
	let count = 0
	const handled = new WeakSet<Element>()

	const items = (): ReadonlyArray<HTMLElement> =>
		Array.from(content.children).filter(
			(child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute("data-message-scroller-spacer"),
		)
	const paddings = () => {
		const style = getComputedStyle(content)
		return { start: px(style.paddingTop), end: px(style.paddingBottom) }
	}
	const contentBottom = (): number => {
		const top = viewport.getBoundingClientRect().top
		const pad = paddings()
		return items().reduce(
			(bottom, item) => Math.max(bottom, item.getBoundingClientRect().bottom - top + viewport.scrollTop + pad.end),
			pad.start + pad.end,
		)
	}
	const setSpacer = (height: number) => {
		const spacer = spacerOf()
		if (spacer === null) return
		const value = Math.max(0, Math.ceil(height))
		const gap = px(getComputedStyle(content).rowGap)
		spacer.hidden = value === 0
		spacer.style.height = `${value}px`
		spacer.style.marginTop = value > 0 ? `${-gap}px` : ""
	}
	const syncButton = () => {
		const isEnd = mode !== "following-bottom" && contentBottom() - viewport.scrollTop - viewport.clientHeight > EDGE_THRESHOLD
		if (!(button instanceof HTMLElement)) return
		button.dataset.active = String(isEnd)
		button.toggleAttribute("inert", !isEnd)
		button.tabIndex = isEnd ? 0 : -1
	}
	const scrollTo = (top: number, behavior: ScrollBehavior) => {
		const target = Math.max(0, top)
		if (Math.abs(viewport.scrollTop - target) <= HALF_PIXEL) viewport.scrollTop = target
		else viewport.scrollTo({ top: target, behavior })
		syncButton()
	}
	const toEnd = (behavior: ScrollBehavior) => {
		setSpacer(0)
		anchored = null
		mode = "following-bottom"
		scrollTo(viewport.scrollHeight - viewport.clientHeight, behavior)
	}
	/** `scrollToElement(…, { align: "start" }, { keepPreviousPeek: true })`. */
	const anchorTo = (element: HTMLElement) => {
		const offset = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
		const target = offset - paddings().start - PREVIOUS_PEEK
		setSpacer(target + viewport.clientHeight - contentBottom())
		anchored = element
		mode = "anchored-to-message"
		scrollTo(target, "auto")
	}
	/** `scrollToMessage(id, { align: "start" })`: a permalink's message at the top, left where it lands. */
	const jumpTo = (element: HTMLElement, behavior: ScrollBehavior = "auto") => {
		const offset = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
		const target = offset - paddings().start
		setSpacer(target + viewport.clientHeight - contentBottom())
		anchored = null
		mode = "settling-jump"
		scrollTo(target, behavior)
	}
	const isAnchor = (element: HTMLElement) => element.dataset.scrollAnchor === "true"
	// Replies are laid out once their markdown parses (`data-markdown-pending` clears), so the
	// permalink waits for that, as a queued jump.
	let pendingFocus = focusMessageId
	const flushFocus = (): boolean => {
		if (pendingFocus === null || content.hasAttribute("data-markdown-pending")) return false
		const target = items().find((item) => item.dataset.messageId === pendingFocus)
		pendingFocus = null
		if (target === undefined) return false
		jumpTo(target)
		return true
	}

	const onContentChange = () => {
		const list = items()
		const previous = count
		count = list.length
		// The turns already there when the thread loads are history, never re-anchored to later.
		if (previous === 0) {
			list.filter(isAnchor).forEach((item) => handled.add(item))
			return flushFocus() ? undefined : toEnd("auto")
		}
		if (flushFocus()) return
		if (list.length > previous) {
			const added = list.slice(previous).filter(isAnchor)
			const first = added[0]
			if (first !== undefined) {
				if (mode === "following-bottom" && added.length > 1) return toEnd("auto")
				handled.add(first)
				return anchorTo(first)
			}
		} else if (list.length === previous) {
			const pending = list.find((item) => isAnchor(item) && !handled.has(item))
			if (pending !== undefined) {
				handled.add(pending)
				return anchorTo(pending)
			}
		}
		return mode === "following-bottom" ? toEnd("auto") : syncButton()
	}
	const onResize = () => {
		if (mode === "following-bottom") return toEnd("auto")
		if (mode === "anchored-to-message" && anchored !== null && anchored.isConnected) return anchorTo(anchored)
		return syncButton()
	}
	const onUserScroll = () => {
		if (mode !== "free-scrolling") {
			anchored = null
			mode = "free-scrolling"
		}
	}
	const onKey = (event: KeyboardEvent) => {
		if (SCROLL_KEYS.has(event.key)) onUserScroll()
	}
	const onClick = () => toEnd("smooth")
	const onScrollToMessage = (event: Event) => {
		const id = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : null
		const target = items().find((item) => item.dataset.messageId === id)
		if (target !== undefined) jumpTo(target, "smooth")
	}

	const mutation = new MutationObserver(onContentChange)
	const markdownSettled = new MutationObserver(() => {
		flushFocus()
	})
	let frame = 0
	const resize = new ResizeObserver(() => {
		cancelAnimationFrame(frame)
		frame = requestAnimationFrame(onResize)
	})
	mutation.observe(content, { childList: true })
	markdownSettled.observe(content, { attributeFilter: ["data-markdown-pending"] })
	resize.observe(viewport)
	resize.observe(content)
	viewport.addEventListener("scroll", syncButton, { passive: true })
	viewport.addEventListener("wheel", onUserScroll, { passive: true })
	viewport.addEventListener("touchmove", onUserScroll, { passive: true })
	viewport.addEventListener("keydown", onKey)
	button?.addEventListener("click", onClick)
	root.addEventListener(SCROLL_TO_MESSAGE, onScrollToMessage)
	onContentChange()
	return () => {
		mutation.disconnect()
		markdownSettled.disconnect()
		resize.disconnect()
		cancelAnimationFrame(frame)
		viewport.removeEventListener("scroll", syncButton)
		viewport.removeEventListener("wheel", onUserScroll)
		viewport.removeEventListener("touchmove", onUserScroll)
		viewport.removeEventListener("keydown", onKey)
		button?.removeEventListener("click", onClick)
		root.removeEventListener(SCROLL_TO_MESSAGE, onScrollToMessage)
	}
}

/** On the `message-scroller` root; `focusMessageId` is a `?m=` permalink to open on. */
export const MountMessageScroller = Mount.define("MountChatMessageScroller", {
	args: { focusMessageId: Schema.NullOr(Schema.String) },
	messages: [CompletedMountScroller],
	execute: ({ element, focusMessageId }) =>
		Effect.as(
			Effect.acquireRelease(
				Effect.sync(() => attach(element, focusMessageId)),
				(release) => Effect.sync(release),
			),
			CompletedMountScroller(),
		),
})

export const CompletedMountJump = defineMessageUnion({ CompletedMountJump: {} }).CompletedMountJump

/**
 * `JumpToDiagnosis`: on its button, hidden while the message is in view (the scroller's
 * IntersectionObserver, 64 px peek off the top); a press asks the scroller to bring it up.
 */
export const MountJumpToMessage = Mount.define("MountChatJumpToMessage", {
	args: { messageId: Schema.String },
	messages: [CompletedMountJump],
	execute: ({ element, messageId }) =>
		Effect.as(
			Effect.acquireRelease(
				Effect.sync(() => {
					const root = element.closest("[data-slot=message-scroller]")
					const viewport = root?.querySelector("[data-slot=message-scroller-viewport]")
					const target = root?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
					if (!(element instanceof HTMLElement) || root == null || !(viewport instanceof HTMLElement) || target == null)
						return () => {}
					const observer = new IntersectionObserver(
						(entries) => entries.forEach((entry) => element.toggleAttribute("hidden", entry.isIntersecting)),
						{ root: viewport, rootMargin: `${-PREVIOUS_PEEK}px 0px 0px 0px`, threshold: [0, 0.01, 0.5, 1] },
					)
					observer.observe(target)
					const onClick = () => root.dispatchEvent(new CustomEvent(SCROLL_TO_MESSAGE, { detail: messageId }))
					element.addEventListener("click", onClick)
					return () => {
						observer.disconnect()
						element.removeEventListener("click", onClick)
					}
				}),
				(release) => Effect.sync(release),
			),
			CompletedMountJump(),
		),
})
