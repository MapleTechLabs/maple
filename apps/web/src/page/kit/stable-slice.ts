// A view's inputs as one object, kept by reference while every field is: a `createLazy` slot keyed on
// it skips the renders that change nothing the view reads.

const sameFields = <R extends object>(previous: R, next: R): boolean => {
	const before = Object.values(previous)
	const after = Object.values(next)
	return before.length === after.length && before.every((value, index) => value === after[index])
}

/**
 * Wraps `select` so a result whose fields all equal the previous one's returns the previous object.
 * `select` must build the same keys in the same order every call. One per render position.
 */
export const stableSlice = <S, R extends object>(select: (source: S) => R): ((source: S) => R) => {
	const last: Array<R> = []
	return (source) => {
		const next = select(source)
		const previous = last[0]
		if (previous !== undefined && sameFields(previous, next)) return previous
		last[0] = next
		return next
	}
}
