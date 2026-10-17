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
	/** True when the edits differ from the saved value. */
	readonly isDirty: boolean
	readonly setDraft: (next: T) => void
	/** Derive the next draft from the current one (the edits, else the saved value). */
	readonly updateDraft: (update: (current: T) => T) => void
	/** Drop the edits and follow the saved value again. Call it after a successful save too. */
	readonly discard: () => void
}

/**
 * Draft state for a settings form over a server value. Holds only the user's edits, so a fresh
 * `saved` value flows straight into an untouched form without any effect syncing it in.
 */
export function useSettingsDraft<T>(
	saved: T,
	isEqual: (a: T, b: T) => boolean = isSameDraft,
): SettingsDraft<T> {
	const [edited, setEdited] = React.useState<{ readonly value: T } | null>(null)
	const draft = edited === null ? saved : edited.value

	const setDraft = React.useCallback((next: T) => setEdited({ value: next }), [])
	const updateDraft = React.useCallback(
		(update: (current: T) => T) =>
			setEdited((current) => ({ value: update(current === null ? saved : current.value) })),
		[saved],
	)
	const discard = React.useCallback(() => setEdited(null), [])

	return {
		draft,
		isDirty: edited !== null && !isEqual(edited.value, saved),
		setDraft,
		updateDraft,
		discard,
	}
}
