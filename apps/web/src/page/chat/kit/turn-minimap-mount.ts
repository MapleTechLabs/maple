import { Effect, Queue, Stream } from "effect"
import { Mount } from "foldkit"
import { MinimapMessage } from "./turn-minimap"

// The rail's DOM side: its width, which rows intersect the viewport (`useMessageScrollerVisibility`),
// the pointer and keyboard preview, and the jump itself (`scrollToMessage`, smooth, row at the top).

const VIEWPORT = "[data-slot=message-scroller-viewport]"
const ITEM = "[data-slot=message-scroller-item]"

const indexFromPointer = (rail: Element, clientY: number, count: number): number | null => {
	const rect = rail.getBoundingClientRect()
	if (count <= 0 || rect.height <= 0) return null
	if (count === 1) return 0
	const progress = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
	return Math.max(0, Math.min(count - 1, Math.round(progress * (count - 1))))
}

const scrollToRow = (viewport: Element | null, id: string): void => {
	const row = viewport?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
	if (viewport instanceof HTMLElement && row instanceof HTMLElement)
		viewport.scrollTo({ top: row.offsetTop - viewport.offsetTop, behavior: "smooth" })
}

export const MountTurnMinimap = Mount.defineStream("MountChatTurnMinimap", {
	messages: [MinimapMessage.MeasuredMinimapRail, MinimapMessage.ChangedVisibleRows, MinimapMessage.PreviewedTurn],
	execute: ({ element }) =>
		Stream.callback<MinimapMessage>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const emit = (message: MinimapMessage) => Queue.offerUnsafe(queue, message)
					const viewport = element.parentElement?.querySelector(VIEWPORT) ?? null
					const visible = new Set<string>()
					const rail = () => element.querySelector("[data-turn-rail]")
					const count = () => Number(rail()?.getAttribute("data-turn-rail") ?? "0")
					const idAt = (index: number) => element.querySelectorAll("[data-turn-id]")[index]?.getAttribute("data-turn-id") ?? null
					const resize = new ResizeObserver(() =>
						emit(MinimapMessage.MeasuredMinimapRail({ width: element.getBoundingClientRect().width })),
					)
					resize.observe(element)
					const intersection = new IntersectionObserver(
						(entries) => {
							entries.forEach((entry) => {
								const id = entry.target.getAttribute("data-message-id")
								if (id === null) return
								if (entry.isIntersecting) visible.add(id)
								else visible.delete(id)
							})
							emit(MinimapMessage.ChangedVisibleRows({ ids: [...visible] }))
						},
						{ root: viewport },
					)
					const observeRows = () => viewport?.querySelectorAll(ITEM).forEach((row) => intersection.observe(row))
					observeRows()
					const mutation = new MutationObserver(observeRows)
					if (viewport !== null) mutation.observe(viewport, { childList: true, subtree: true })
					let active: number | null = null
					const preview = (index: number | null) => {
						active = index
						emit(MinimapMessage.PreviewedTurn({ index }))
					}
					const isPreview = (target: EventTarget | null) =>
						target instanceof Element && target.closest("[data-turn-minimap-preview]") !== null
					const onMove = (event: Event) => {
						const target = rail()
						if (!(event instanceof MouseEvent) || target === null || isPreview(event.target)) return
						const index = indexFromPointer(target, event.clientY, count())
						if (index !== active) preview(index)
					}
					const onClick = (event: Event) => {
						const stepTarget = event.target instanceof Element ? event.target.closest("[data-turn-target]") : null
						if (stepTarget !== null) return scrollToRow(viewport, stepTarget.getAttribute("data-turn-target") ?? "")
						const target = rail()
						if (!(event instanceof MouseEvent) || target === null || isPreview(event.target)) return
						if (!target.contains(event.target instanceof Node ? event.target : null)) return
						const index = indexFromPointer(target, event.clientY, count())
						const id = index === null ? null : idAt(index)
						if (id !== null) scrollToRow(viewport, id)
						if (target instanceof HTMLElement) target.blur()
					}
					const onKey = (event: Event) => {
						if (!(event instanceof KeyboardEvent) || event.target !== rail()) return
						const last = count() - 1
						const from = active ?? Number(rail()?.getAttribute("data-turn-current") ?? "0")
						const next = new Map([
							["ArrowDown", Math.min(last, from + 1)],
							["ArrowUp", Math.max(0, from - 1)],
							["Home", 0],
							["End", last],
						]).get(event.key)
						if (next !== undefined) {
							event.preventDefault()
							preview(next)
						} else if (event.key === "Enter" || event.key === " ") {
							event.preventDefault()
							const id = active === null ? null : idAt(active)
							if (id !== null) scrollToRow(viewport, id)
						}
					}
					const onLeave = () => preview(null)
					const onFocus = (event: Event) => {
						if (event.target === rail() && active === null) preview(Number(rail()?.getAttribute("data-turn-current") ?? "0"))
					}
					const onBlur = (event: Event) => {
						if (event.target === rail()) preview(null)
					}
					element.addEventListener("mousemove", onMove)
					element.addEventListener("mouseleave", onLeave)
					element.addEventListener("click", onClick)
					element.addEventListener("keydown", onKey)
					element.addEventListener("focusin", onFocus)
					element.addEventListener("focusout", onBlur)
					return () => {
						resize.disconnect()
						intersection.disconnect()
						mutation.disconnect()
						element.removeEventListener("mousemove", onMove)
						element.removeEventListener("mouseleave", onLeave)
						element.removeEventListener("click", onClick)
						element.removeEventListener("keydown", onKey)
						element.removeEventListener("focusin", onFocus)
						element.removeEventListener("focusout", onBlur)
					}
				}),
				(release) => Effect.sync(release),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
