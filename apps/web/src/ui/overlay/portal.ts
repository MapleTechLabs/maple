import { Array, Effect, Option, type Scope } from "effect"

/**
 * DOM side of Base UI's floating layer, used by overlay Mounts: the portal to `<body>`, marking
 * what lies outside a popup, the scroll lock, and moving focus in and back out.
 */

/** `FloatingPortal`: the element lives at the end of `<body>` while mounted. */
export const portalToBody = (element: Element): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => document.body.appendChild(element)),
		() => Effect.sync(() => element.remove()),
	)

const INERT_MARKER = "data-base-ui-inert"

/** Every element on the way from `<body>` down to the kept ones (`buildKeepSet`). */
const ancestry = (node: Node | null): ReadonlyArray<Node> =>
	node === null ? [] : [node, ...ancestry(node.parentNode)]

const keepSet = (targets: ReadonlyArray<Element>): ReadonlySet<Node> => new Set(targets.flatMap(ancestry))

/** A portal still in the page, about to move to `<body>`: neither outside nor kept. */
const isLeavingPortal = (element: Element) =>
	element.hasAttribute("data-base-ui-portal") && element.parentElement !== document.body

/** `collectOutsideElements`: the siblings along those paths, not descending into kept elements. */
const outsideOf = (targets: ReadonlyArray<Element>): ReadonlyArray<Element> => {
	const keep = keepSet(targets)
	const stop = new Set<Node>(targets)
	const walk = (parent: Element): ReadonlyArray<Element> =>
		stop.has(parent)
			? []
			: Array.fromIterable(parent.children).flatMap((child) =>
					child.tagName === "SCRIPT" || isLeavingPortal(child)
						? []
						: keep.has(child)
							? walk(child)
							: [child],
				)
	return walk(document.body)
}

const setUntil = (elements: ReadonlyArray<Element>, name: string, value: string) =>
	Array.filter(elements, (element) => !element.hasAttribute(name)).map((element) => {
		element.setAttribute(name, value)
		return { element, name }
	})

/**
 * Base UI's `markOthers` (floating-ui-react/utils/markOthers.mjs): what lies outside the popup
 * gets the inert marker; with `ariaHidden`, what lies outside the popup, the `keep` elements
 * (a combobox field) and the live regions also gets `aria-hidden`.
 */
export const markOutside = (
	element: Element,
	options: Readonly<{ mark: boolean; ariaHidden: boolean; keep?: ReadonlyArray<string> }>,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		// Wait a task: portals mounted in the same render (the toast regions) reach <body> first.
		Effect.andThen(
			Effect.sleep(0),
			Effect.sync(() => {
				const kept = [
					element,
					...Array.getSomes(
						(options.keep ?? []).map((s) => Option.fromNullishOr(document.querySelector(s))),
					),
				]
				// A live region in a portal still on its way to <body> will not be under the marked page.
				const live = Array.filter(
					Array.fromIterable(document.body.querySelectorAll("[aria-live]")),
					(region) => {
						const portal = region.closest("[data-base-ui-portal]")
						return portal === null || portal.parentElement === document.body
					},
				)
				return [
					...(options.ariaHidden
						? setUntil(outsideOf([...kept, ...live]), "aria-hidden", "true")
						: []),
					...(options.mark ? setUntil(outsideOf([element]), INERT_MARKER, "") : []),
				]
			}),
		),
		(changed) =>
			Effect.sync(() => changed.forEach(({ element: other, name }) => other.removeAttribute(name))),
	).pipe(Effect.asVoid)

/**
 * Base UI's scroll lock for a page without a scrollbar: `overflow: hidden` on `<body>`. Locks
 * nest (a menu closing as its dialog opens): the count lives on `<body>`, the first saves overflow.
 */
export const lockBodyScroll: Effect.Effect<void, never, Scope.Scope> = Effect.acquireRelease(
	Effect.sync(() => {
		const body = document.body
		const count = Number(body.dataset["scrollLocks"] ?? "0")
		if (count === 0) {
			body.dataset["scrollLockOverflow"] = body.style.overflow
			body.style.overflow = "hidden"
		}
		body.dataset["scrollLocks"] = String(count + 1)
	}),
	() =>
		Effect.sync(() => {
			const body = document.body
			const count = Number(body.dataset["scrollLocks"] ?? "1") - 1
			if (count > 0) {
				body.dataset["scrollLocks"] = String(count)
				return
			}
			body.style.overflow = body.dataset["scrollLockOverflow"] ?? ""
			delete body.dataset["scrollLocks"]
			delete body.dataset["scrollLockOverflow"]
		}),
)

/**
 * An open popup's Escape stays inside it: keydowns reaching `container` stop there, so an
 * enclosing dialog's Escape handler does not also close (Base UI closes only the popup).
 */
export const containEscape = (container: EventTarget): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const onKeyDown = (event: Event) => {
				if ("key" in event && event.key === "Escape") event.stopPropagation()
			}
			container.addEventListener("keydown", onKeyDown)
			return onKeyDown
		}),
		(onKeyDown) => Effect.sync(() => container.removeEventListener("keydown", onKeyDown)),
	).pipe(Effect.asVoid)

const TABBABLE =
	"a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]"

/** Tabbable descendants in DOM order, skipping focus guards and `tabindex="-1"`. */
export const tabbables = (container: Element): ReadonlyArray<HTMLElement> =>
	Array.filter(
		Array.fromIterable(container.querySelectorAll<HTMLElement>(TABBABLE)),
		(element) =>
			element.tabIndex >= 0 &&
			!element.hasAttribute("data-base-ui-focus-guard") &&
			element.getAttribute("aria-hidden") !== "true",
	)

/**
 * A modal popup's focus trap: focus reaching the guard before the popup wraps to its last
 * tabbable, the guard after it to its first.
 */
export const trapFocus = (
	container: HTMLElement,
	popup: HTMLElement,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const onFocusIn = (event: FocusEvent) => {
				const guard = event.target
				if (!(guard instanceof HTMLElement) || !guard.hasAttribute("data-base-ui-focus-guard")) return
				const inside = tabbables(popup)
				const isBefore =
					(guard.compareDocumentPosition(popup) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
				const target = isBefore ? inside[inside.length - 1] : inside[0]
				;(target ?? popup).focus({ preventScroll: true })
			}
			container.addEventListener("focusin", onFocusIn)
			return onFocusIn
		}),
		(onFocusIn) => Effect.sync(() => container.removeEventListener("focusin", onFocusIn)),
	).pipe(Effect.asVoid)

/**
 * `FloatingFocusManager`'s initial focus and return focus: the first tabbable (else the popup)
 * on mount; on release focus goes back to the trigger, or to what had it before.
 */
export const manageFocus = (
	popup: HTMLElement,
	options: Readonly<{
		returnFocusId: Option.Option<string>
		initialFocus: "first-tabbable" | "popup" | "highlighted" | "none"
		/** `false`: closing leaves focus where it is (no trigger or earlier element to go back to). */
		isReturningFocus?: boolean
	}>,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const previous = document.activeElement
			const target =
				options.initialFocus === "first-tabbable"
					? // An `[autofocus]` element is focused first, and the manager leaves it there.
						(popup.querySelector<HTMLElement>("[autofocus]") ?? tabbables(popup)[0] ?? popup)
					: options.initialFocus === "highlighted"
						? (popup.querySelector<HTMLElement>("[data-highlighted]") ?? popup)
						: popup
			// Floating UI scrolls an element it focuses into view (an input to its caret); only the popup is not.
			if (options.initialFocus !== "none") target.focus({ preventScroll: target === popup })
			return previous
		}),
		(previous) =>
			Effect.sync(() => {
				// Like FloatingFocusManager, focus that has moved on (a dialog a menu item opened) stays.
				const active = document.activeElement
				const hasMovedOn =
					active !== null &&
					active !== document.body &&
					active.isConnected &&
					!popup.contains(active)
				if (hasMovedOn || options.isReturningFocus === false) return
				const returnTo = Option.flatMapNullishOr(options.returnFocusId, (id) =>
					document.getElementById(id),
				)
				const fallback = previous instanceof HTMLElement && previous.isConnected ? previous : null
				Option.getOrElse(returnTo, () => fallback)?.focus({ preventScroll: true })
			}),
	).pipe(Effect.asVoid)
