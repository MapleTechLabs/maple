import * as React from "react"

/**
 * Structural equality over the plain data a settings form edits (primitives, arrays, plain
 * objects). Key order does not matter; a key holding `undefined` equals a missing key, so a
 * cleared optional field does not count as a change.
 */
export function isSameDraft(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
		return a.every((value, index) => isSameDraft(value, b[index]))
	}
	if (!isPlainRecord(a) || !isPlainRecord(b)) return false
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])
	return [...keys].every((key) => isSameDraft(a[key], b[key]))
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype

export interface SettingsDraft<T> {
	/** What the form shows: the user's edits, else the saved value. */
	readonly draft: T
	/** True when the edits differ from the saved value and have not been committed. */
	readonly isDirty: boolean
	readonly setDraft: (next: T) => void
	/** Derive the next draft from the current one (the edits, else the saved value). */
	readonly updateDraft: (update: (current: T) => T) => void
	/** Drop the edits and follow the saved value again (the Discard action). */
	readonly discard: () => void
	/**
	 * Call after a successful save. Keeps showing the edits until the saved value catches up
	 * (equals them, or changes at all), so the form does not flash back while the refetch lands.
	 */
	readonly commit: () => void
}

interface Edits<T> {
	readonly value: T
	/** Set by `commit()`: the saved value the save started from. */
	readonly committedOver?: { readonly saved: T }
}

/**
 * Draft state for a settings form over a server value. Holds only the user's edits, so a fresh
 * `saved` value flows straight into an untouched form without any effect syncing it in.
 */
export function useSettingsDraft<T>(
	saved: T,
	isEqual: (a: T, b: T) => boolean = isSameDraft,
): SettingsDraft<T> {
	const [edits, setEdits] = React.useState<Edits<T> | null>(null)
	const settled =
		edits?.committedOver !== undefined &&
		(isEqual(edits.value, saved) || !isEqual(edits.committedOver.saved, saved))
	// Render-phase reset: once the saved value caught up, committed edits are dropped for good.
	if (settled) setEdits(null)
	const active = settled ? null : edits
	const draft = active === null ? saved : active.value

	const setDraft = React.useCallback((next: T) => setEdits({ value: next }), [])
	const updateDraft = React.useCallback(
		(update: (current: T) => T) =>
			setEdits((current) => ({ value: update(current === null ? saved : current.value) })),
		[saved],
	)
	const discard = React.useCallback(() => setEdits(null), [])
	const commit = React.useCallback(
		() =>
			setEdits((current) =>
				current === null ? null : { value: current.value, committedOver: { saved } },
			),
		[saved],
	)

	return {
		draft,
		isDirty: active !== null && active.committedOver === undefined && !isEqual(active.value, saved),
		setDraft,
		updateDraft,
		discard,
		commit,
	}
}
