import { Effect } from "effect"
import { Mount } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

// `MessageScroller` (packages/ui message-scroller.tsx, `autoScroll`, `defaultScrollPosition="end"`):
// opens at the end, follows new content while the reader is at the end, and shows the jump button
// once they scroll up. Pure DOM bookkeeping on the viewport, so it lives in a Mount.
// TODO(chat-scroll-anchor): legacy also anchors each new user turn near the top of the viewport.

export const ScrollerMessage = defineMessageUnion({ CompletedMountScroller: {} })
export const CompletedMountScroller = ScrollerMessage.CompletedMountScroller

const AT_END_SLACK = 8

const isAtEnd = (viewport: HTMLElement): boolean =>
	viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= AT_END_SLACK

const setButtonActive = (button: Element | null, isActive: boolean): void => {
	if (!(button instanceof HTMLElement)) return
	button.dataset.active = String(isActive)
	button.toggleAttribute("inert", !isActive)
}

/** On the `message-scroller` root: its viewport, content and jump button are its children. */
export const MountMessageScroller = Mount.define("MountChatMessageScroller", {
	messages: [CompletedMountScroller],
	execute: ({ element }) =>
		Effect.as(
			Effect.acquireRelease(
				Effect.sync(() => {
					const viewport = element.querySelector("[data-slot=message-scroller-viewport]")
					const content = element.querySelector("[data-slot=message-scroller-content]")
					const button = element.querySelector("[data-slot=message-scroller-button]")
					if (!(viewport instanceof HTMLElement) || !(content instanceof HTMLElement)) return () => {}
					let stick = true
					const toEnd = (behavior: ScrollBehavior) => viewport.scrollTo({ top: viewport.scrollHeight, behavior })
					const onScroll = () => {
						stick = isAtEnd(viewport)
						setButtonActive(button, !stick)
					}
					const onClick = () => toEnd("smooth")
					const observer = new ResizeObserver(() => {
						if (stick) toEnd("auto")
						setButtonActive(button, !isAtEnd(viewport))
					})
					toEnd("auto")
					observer.observe(content)
					viewport.addEventListener("scroll", onScroll, { passive: true })
					button?.addEventListener("click", onClick)
					return () => {
						observer.disconnect()
						viewport.removeEventListener("scroll", onScroll)
						button?.removeEventListener("click", onClick)
					}
				}),
				(release) => Effect.sync(release),
			),
			CompletedMountScroller(),
		),
})
