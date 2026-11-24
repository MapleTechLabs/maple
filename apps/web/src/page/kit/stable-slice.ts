import { Array as Arr, Equal, Record as Rec } from "effect"
// A view's inputs as one object, kept by reference while every field is: a `createLazy` slot keyed on
// it skips the renders that change nothing the view reads.

const sameFields = <R extends object>(previous: R, next: R): boolean => {
	const before = Rec.values(previous)
	const after = Rec.values(next)
	return before.length === after.length && Arr.every(before, (value, index) => value === after[index])
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

/**
 * Wraps `select` so a result structurally equal (`Equal.equals`) to the previous one returns the
 * previous value. For derived inputs rebuilt on every call (an `Option`, a small record) that a
 * `createLazy` slot compares by reference. One per render position.
 */
export const stableValue = <S, A>(select: (source: S) => A): ((source: S) => A) => {
	const last: Array<{ readonly value: A }> = []
	return (source) => {
		const next = select(source)
		const previous = last[0]
		if (previous !== undefined && Equal.equals(previous.value, next)) return previous.value
		last[0] = { value: next }
		return next
	}
}

/**
 * `next` with every row structurally equal to the `previous` row of the same key swapped for that
 * previous object, and `previous` itself when nothing changed. Live sync resends a whole collection
 * as fresh copies; this keeps unchanged rows by reference so caches keyed on them keep hitting.
 */
export const reuseUnchangedRows = <A>(
	previous: ReadonlyArray<A> | null,
	next: ReadonlyArray<A>,
	keyOf: (row: A) => string,
): ReadonlyArray<A> => {
	if (previous === null || previous.length === 0) return next
	const byKey = new Map(Arr.map(previous, (row) => [keyOf(row), row] as const))
	let isSame = previous.length === next.length
	const rows = Arr.map(next, (row, index) => {
		const kept = byKey.get(keyOf(row))
		const reused = kept !== undefined && Equal.equals(kept, row) ? kept : row
		if (reused !== previous[index]) isSame = false
		return reused
	})
	return isSame ? previous : rows
}
