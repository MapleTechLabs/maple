/**
 * The command list's motion, written onto the mounted elements: one highlight pill that slides to
 * the highlighted option (`command-motion.css` draws it), and the list easing to its new height
 * as the results change. Returns its cleanup.
 */
export const trackCommandMotion = (
	viewport: HTMLElement,
	isResizing: (value: boolean) => void,
): (() => void) => {
	const list = viewport.querySelector<HTMLElement>(':scope > [data-slot="command-list"]')
	const root = viewport.parentElement
	const popup = root?.closest<HTMLElement>('[role="dialog"]') ?? null
	const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	const frames = new Set<number>()
	const nextFrame = (run: () => void) => {
		const id = requestAnimationFrame(() => {
			frames.delete(id)
			run()
		})
		frames.add(id)
	}

	const placeHighlight = () => {
		if (list === null) return
		const item = list.querySelector<HTMLElement>('[data-slot="command-item"][data-highlighted]')
		if (item === null) {
			list.removeAttribute("data-highlight-shown")
			list.removeAttribute("data-highlight-moving")
			return
		}
		list.style.setProperty("--command-highlight-x", `${item.offsetLeft}px`)
		list.style.setProperty("--command-highlight-y", `${item.offsetTop}px`)
		list.style.setProperty("--command-highlight-width", `${item.offsetWidth}px`)
		list.style.setProperty("--command-highlight-height", `${item.offsetHeight}px`)
		list.toggleAttribute("data-highlight-shown", true)
	}

	// The pill slides after the pointer and snaps to the keyboard: arrow keys are pressed in
	// quick runs, and a trailing highlight would lag the row the next Enter opens.
	const onPointerMove = () => {
		if (!reduced) list?.toggleAttribute("data-highlight-moving", true)
	}
	const onKeyDown = () => list?.removeAttribute("data-highlight-moving")

	const fitHeight = () => {
		if (root === null || popup === null || list === null) return
		const maxHeight = Number.parseFloat(getComputedStyle(popup).maxHeight)
		const others = popup.offsetHeight - root.offsetHeight
		const available = Number.isFinite(maxHeight) ? maxHeight - others : Number.POSITIVE_INFINITY
		const height = `${Math.max(0, Math.min(list.offsetHeight, available))}px`
		if (root.style.height !== height) root.style.height = height
	}

	const onTransition = (event: TransitionEvent) => {
		if (event.target !== root || event.propertyName !== "height") return
		isResizing(event.type === "transitionrun")
	}

	list?.toggleAttribute("data-highlight", true)
	placeHighlight()
	fitHeight()
	// The first height lands in place; later ones ease.
	if (!reduced && root !== null)
		nextFrame(() => {
			root.style.transition = "height 120ms var(--ease-out)"
		})
	list?.addEventListener("pointermove", onPointerMove, { passive: true })
	document.addEventListener("keydown", onKeyDown, { capture: true })
	root?.addEventListener("transitionrun", onTransition)
	root?.addEventListener("transitionend", onTransition)
	root?.addEventListener("transitioncancel", onTransition)

	const update = () => {
		fitHeight()
		placeHighlight()
	}
	const mutations = new MutationObserver(update)
	if (list !== null)
		mutations.observe(list, { subtree: true, childList: true, attributeFilter: ["data-highlighted"] })
	const sizes = new ResizeObserver(update)
	if (list !== null) sizes.observe(list)

	return () => {
		mutations.disconnect()
		sizes.disconnect()
		frames.forEach((id) => cancelAnimationFrame(id))
		list?.removeEventListener("pointermove", onPointerMove)
		document.removeEventListener("keydown", onKeyDown, { capture: true })
		root?.removeEventListener("transitionrun", onTransition)
		root?.removeEventListener("transitionend", onTransition)
		root?.removeEventListener("transitioncancel", onTransition)
	}
}
