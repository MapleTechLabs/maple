// rrweb replaces the stylesheet methods a page calls with proxies that run the
// real method inside its error handler, so an exception the method raises for the
// page reads as a recorder failure. These pass-throughs sit under rrweb's proxies
// and remember what the method itself threw.

const pageThrows = new WeakSet()

/** Whether a DOM method raised `error` for the page that called it, rather than the recorder failing. */
export function isPageThrow(error: unknown): boolean {
	return typeof error === "object" && error !== null && pageThrows.has(error)
}

/** `native`, remembering whatever it throws. It keeps the method's `name` and `length`. */
function remembering<This, Args extends Array<unknown>, Result>(
	native: (this: This, ...args: Args) => Result,
): (this: This, ...args: Args) => Result {
	const wrapper = function (this: This, ...args: Args): Result {
		try {
			return native.apply(this, args)
		} catch (error) {
			if (typeof error === "object" && error !== null) pageThrows.add(error)
			throw error
		}
	}
	return Object.defineProperties(wrapper, {
		name: { value: native.name, configurable: true },
		length: { value: native.length, configurable: true },
	})
}

/**
 * Put a pass-through over the prototype's own `name`; returns how to take it off
 * again. Curried so the method's type is read from that one property.
 */
const watchMethod =
	<Name extends string>(name: Name) =>
	<This, Args extends Array<unknown>, Result>(
		prototype: Record<Name, (this: This, ...args: Args) => Result>,
	): (() => void) | undefined => {
		try {
			// Own and plain only: an inherited method is watched on the prototype that owns it.
			const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
			if (!descriptor?.configurable || !descriptor.writable) return undefined
			const wrapper = remembering(prototype[name])
			Object.defineProperty(prototype, name, { ...descriptor, value: wrapper })
			return () => {
				// Something patched over it since: taking the pass-through out would drop that patch.
				if (prototype[name] === wrapper) Object.defineProperty(prototype, name, descriptor)
			}
		} catch {
			// A method that cannot be wrapped keeps rrweb's behaviour; capture never throws.
			return undefined
		}
	}

/** The rule types rrweb proxies: `CSSGroupingRule` where it exists, its subtypes where it does not. */
function groupingRulePrototypes(): Array<CSSGroupingRule> {
	const prototypes: Array<CSSGroupingRule> = []
	if (typeof CSSGroupingRule !== "undefined") prototypes.push(CSSGroupingRule.prototype)
	if (typeof CSSMediaRule !== "undefined") prototypes.push(CSSMediaRule.prototype)
	if (typeof CSSConditionRule !== "undefined") prototypes.push(CSSConditionRule.prototype)
	if (typeof CSSSupportsRule !== "undefined") prototypes.push(CSSSupportsRule.prototype)
	return prototypes
}

/** Watch every method rrweb runs inside its error handler on the page's behalf. */
function watchAll(): Array<() => void> {
	const undo: Array<(() => void) | undefined> = []
	if (typeof CSSStyleSheet !== "undefined") {
		const sheet = CSSStyleSheet.prototype
		undo.push(
			watchMethod("insertRule")(sheet),
			watchMethod("deleteRule")(sheet),
			watchMethod("replace")(sheet),
			watchMethod("replaceSync")(sheet),
		)
	}
	for (const rule of groupingRulePrototypes()) {
		undo.push(watchMethod("insertRule")(rule), watchMethod("deleteRule")(rule))
	}
	if (typeof CSSStyleDeclaration !== "undefined") {
		const declaration = CSSStyleDeclaration.prototype
		undo.push(watchMethod("setProperty")(declaration), watchMethod("removeProperty")(declaration))
	}
	return undo.filter((entry) => entry !== undefined)
}

let watchers = 0
let restore: Array<() => void> = []

/**
 * Start telling a page's own exceptions apart, before rrweb installs its proxies.
 * Returns a release; the methods are the page's again once every recorder released.
 */
export function watchPageThrows(): () => void {
	if (watchers++ === 0) restore = watchAll()
	let released = false
	return () => {
		if (released) return
		released = true
		if (--watchers > 0) return
		for (const undo of restore) undo()
		restore = []
	}
}
