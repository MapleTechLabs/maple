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

/** A live region, ignoring ones in a portal that has not left this element for `<body>` yet. */
const isLiveRegion = (element: Element) =>
	element.hasAttribute("aria-live") ||
	Array.some(Array.fromIterable(element.querySelectorAll("[aria-live]")), (live) => {
		const portal = live.closest("[data-base-ui-portal]")
		return portal === null || portal === element
	})

/**
 * `markOthers`: every other child of `<body>` gets Base UI's inert marker, and with `ariaHidden`
 * (modal dialogs, context menus) also `aria-hidden`, except live regions such as the toasts.
 */
export const markOutside = (
	element: Element,
	options: Readonly<{ ariaHidden: boolean }>,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		// Yield first: portals mounted in the same render (the toast regions) reach <body> before this runs.
		Effect.andThen(
			Effect.yieldNow,
			Effect.sync(() =>
				Array.filter(
					Array.fromIterable(document.body.children),
					(other) =>
						other !== element && other.tagName !== "SCRIPT" && !other.hasAttribute(INERT_MARKER),
				).map((other) => {
					const hides =
						options.ariaHidden && !isLiveRegion(other) && !other.hasAttribute("aria-hidden")
					other.setAttribute(INERT_MARKER, "")
					if (hides) other.setAttribute("aria-hidden", "true")
					return { other, hides }
				}),
			),
		),
		(marked) =>
			Effect.sync(() =>
				marked.forEach(({ other, hides }) => {
					other.removeAttribute(INERT_MARKER)
					if (hides) other.removeAttribute("aria-hidden")
				}),
			),
	).pipe(Effect.asVoid)

/** Base UI's scroll lock for a page without a scrollbar: `overflow: hidden` on `<body>`. */
export const lockBodyScroll: Effect.Effect<void, never, Scope.Scope> = Effect.acquireRelease(
	Effect.sync(() => {
		const previous = document.body.style.overflow
		document.body.style.overflow = "hidden"
		return previous
	}),
	(previous) =>
		Effect.sync(() => {
			document.body.style.overflow = previous
		}),
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
		initialFocus: "first-tabbable" | "popup" | "none"
	}>,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const previous = document.activeElement
			const target = options.initialFocus === "first-tabbable" ? (tabbables(popup)[0] ?? popup) : popup
			if (options.initialFocus !== "none") target.focus({ preventScroll: true })
			return previous
		}),
		(previous) =>
			Effect.sync(() => {
				const returnTo = Option.flatMapNullishOr(options.returnFocusId, (id) =>
					document.getElementById(id),
				)
				const fallback = previous instanceof HTMLElement && previous.isConnected ? previous : null
				Option.getOrElse(returnTo, () => fallback)?.focus({ preventScroll: true })
			}),
	).pipe(Effect.asVoid)
