import { Array as Arr } from "effect"
// A derivation that views call on every message, recomputed only when one of its inputs changes.

/**
 * Wraps `compute` so a key whose parts all equal (`===`) the previous key's returns the previous
 * result. Key on the model fields the derivation reads, never the whole model. One per call site.
 */
export const lastBy = <K extends ReadonlyArray<unknown>, A>(compute: (key: K) => A): ((key: K) => A) => {
	const last: Array<{ key: K; value: A }> = []
	return (key) => {
		const previous = last[0]
		if (
			previous !== undefined &&
			previous.key.length === key.length &&
			Arr.every(key, (part, index) => part === previous.key[index])
		)
			return previous.value
		const value = compute(key)
		last[0] = { key, value }
		return value
	}
}
