/**
 * Wrap a method of a page global (`fetch`, `XMLHttpRequest.prototype.send`,
 * `history.pushState`, `console.log`) without breaking whatever else wraps it.
 *
 * Capture starts and stops many times in one page. Restoring the method we
 * found deleted any wrapper installed after ours (an auth interceptor, a mock
 * service worker, another SDK), and wrapping again on every start grew the
 * chain. So a page has one wrapper per method: teardown restores the original
 * only while ours is still on top, and otherwise leaves it in place, inert,
 * for the next start to reuse.
 */

interface Slot<H> {
	readonly original: unknown
	wrapper: unknown
	hooks: H | undefined
}

const slots = new WeakMap<object, Map<PropertyKey, Slot<unknown>>>()

/**
 * Install `wrap(original, hooks)` as `target[key]`, or reuse the wrapper an
 * earlier call left in place. The wrapper must read `hooks()` on every call
 * and only forward to `original` when it is undefined. Returns the teardown.
 */
export function patchMethod<T extends object, K extends keyof T, H>(
	target: T,
	key: K,
	hooks: H,
	wrap: (original: T[K], hooks: () => H | undefined) => T[K],
): () => void {
	let byKey = slots.get(target)
	if (!byKey) {
		byKey = new Map()
		slots.set(target, byKey)
	}
	let slot = byKey.get(key)
	// Out of the chain for certain only when someone put back exactly what we wrapped.
	if (slot && target[key] !== slot.wrapper && target[key] === slot.original) slot = undefined
	if (slot) {
		slot.hooks = hooks
	} else {
		const original = target[key]
		const fresh: Slot<H> = { original, wrapper: undefined, hooks }
		const wrapper = wrap(original, () => fresh.hooks)
		fresh.wrapper = wrapper
		target[key] = wrapper
		byKey.set(key, fresh)
		slot = fresh
	}
	const owned = slot
	const map = byKey
	return () => {
		if (owned.hooks !== hooks) return
		owned.hooks = undefined
		if (target[key] !== owned.wrapper) return
		// `original` is what `target[key]` held, so it has the property's type.
		Reflect.set(target, key, owned.original)
		map.delete(key)
	}
}

/** Test seam: forget the wrappers left inert on `target`, so the next call wraps afresh. */
export function forgetPatchesForTests<T extends object>(target: T): void {
	slots.delete(target)
}
