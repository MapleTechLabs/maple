import { Effect, Queue, Stream } from "effect"

// Click routing the list rows and canvas links need: `OnClick` carries no target or modifiers,
// so a Mount reads the DOM event and these pure rules decide what it means.

type Found = Readonly<{ getAttribute: (name: string) => string | null }>
export type ClickFacts = Readonly<{
	button: number
	metaKey: boolean
	ctrlKey: boolean
	shiftKey: boolean
	altKey: boolean
	defaultPrevented: boolean
	target: Readonly<{ closest: (selector: string) => Found | null }> | null
}>

export const ROW_ATTRIBUTE = "data-investigation-row"
export const NODE_LINK_ATTRIBUTE = "data-node-link"

/** `openRow`: a click outside the row's links opens it; the headline link routes itself. */
export const rowClickId = (click: ClickFacts): string | null => {
	if (click.defaultPrevented || click.target === null || click.target.closest("a") !== null) return null
	return click.target.closest(`li[${ROW_ATTRIBUTE}]`)?.getAttribute(ROW_ATTRIBUTE) ?? null
}

/** A canvas `<Link>`: never the card's click; a plain primary click routes in place, others open natively. */
export const nodeLinkClick = (click: ClickFacts): Readonly<{ href: string; isPlain: boolean }> | null => {
	const href = click.target?.closest(`a[${NODE_LINK_ATTRIBUTE}]`)?.getAttribute("href") ?? null
	if (href === null) return null
	const isPlain = click.button === 0 && !click.metaKey && !click.ctrlKey && !click.shiftKey && !click.altKey
	return { href, isPlain }
}

/** A click listener for a Mount's element, released with it; `capture` runs before the target's handlers. */
export const clickStream = <M>(
	element: Element,
	capture: boolean,
	onClick: (event: MouseEvent, emit: (message: M) => void) => void,
) =>
	Stream.callback<M>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const listener = (event: Event) => {
					if (event instanceof MouseEvent)
						onClick(event, (message) => Queue.offerUnsafe(queue, message))
				}
				element.addEventListener("click", listener, { capture })
				return listener
			}),
			(listener) => Effect.sync(() => element.removeEventListener("click", listener, { capture })),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

export const factsOf = (event: MouseEvent): ClickFacts => ({
	button: event.button,
	metaKey: event.metaKey,
	ctrlKey: event.ctrlKey,
	shiftKey: event.shiftKey,
	altKey: event.altKey,
	defaultPrevented: event.defaultPrevented,
	target: event.target instanceof Element ? event.target : null,
})
