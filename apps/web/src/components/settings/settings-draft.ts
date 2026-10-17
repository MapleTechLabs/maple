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
	 * Call when a save starts: records the draft as in flight and returns it as `submitted`.
	 * Until the saved value moves, edits that differ from it stay dirty even if they equal `saved`.
	 */
	readonly submit: () => T
	/** Call when a save fails: forgets the in-flight value and keeps the edits as they are. */
	readonly abort: () => void
	/**
	 * Call after a successful save with the draft it `submitted` (captured when the save started)
	 * and, when the save normalized it (trimmed, parsed), the value it `sent`. Edits made after
	 * submission stay dirty; otherwise the edits show until the refetch lands.
	 */
	readonly commit: (save: SettingsDraftSave<T>) => void
}

export interface SettingsDraftSave<T> {
	/** The draft as it was when the save started. */
	readonly submitted: T
	/** What the save actually stored, when it differs from `submitted`. */
	readonly sent?: T
}

export interface Edits<T> {
	readonly value: T
	/** Set by `commit()`: the saved value the save started from and the value it sent. */
	readonly committedOver?: { readonly saved: T; readonly sent: T }
}

/** Settles the edits a save stored; edits made after the save started stay plain (dirty). */
export function commitEdits<T>(
	current: Edits<T> | null,
	{ submitted, sent }: SettingsDraftSave<T>,
	saved: T,
	isEqual: (a: T, b: T) => boolean,
): Edits<T> | null {
	if (current === null) return null
	if (!isEqual(current.value, submitted)) return { value: current.value }
	return { value: current.value, committedOver: { saved, sent: sent === undefined ? submitted : sent } }
}

/** A save in flight (or committed but not yet refetched), started over the saved value `base`. */
export interface InFlightSave<T> extends SettingsDraftSave<T> {
	readonly base: T
}

/** The in-flight save is over once the saved value moved off its base or reached what it stores. */
export const isSaveSettled = <T>(save: InFlightSave<T>, saved: T, isEqual: (a: T, b: T) => boolean) =>
	!isEqual(save.base, saved) ||
	isEqual(save.submitted, saved) ||
	(save.sent !== undefined && isEqual(save.sent, saved))

/** Edits that differ from what an unsettled save will store are unsaved, whatever `saved` says. */
export const divergesFromSave = <T>(draft: T, save: SettingsDraftSave<T>, isEqual: (a: T, b: T) => boolean) =>
	!isEqual(draft, save.submitted) && (save.sent === undefined || !isEqual(draft, save.sent))

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
		(isEqual(edits.value, saved) ||
			isEqual(edits.committedOver.sent, saved) ||
			!isEqual(edits.committedOver.saved, saved))
	// Render-phase reset: once the saved value caught up, committed edits are dropped for good.
	if (settled) setEdits(null)
	const active = settled ? null : edits
	const draft = active === null ? saved : active.value
	const [inFlight, setInFlight] = React.useState<InFlightSave<T> | null>(null)
	const saveSettled = inFlight !== null && isSaveSettled(inFlight, saved, isEqual)
	if (saveSettled) setInFlight(null)
	const pending = saveSettled ? null : inFlight

	const setDraft = React.useCallback((next: T) => setEdits({ value: next }), [])
	const updateDraft = React.useCallback(
		(update: (current: T) => T) =>
			setEdits((current) => ({ value: update(current === null ? saved : current.value) })),
		[saved],
	)
	const discard = React.useCallback(() => {
		setEdits(null)
		setInFlight(null)
	}, [])
	const submit = React.useCallback(() => {
		setInFlight({ submitted: draft, base: saved })
		return draft
	}, [draft, saved])
	const abort = React.useCallback(() => setInFlight(null), [])
	// Stays in flight until the refetch moves `saved`, so a revert before it lands is still dirty.
	const commit = React.useCallback(
		(save: SettingsDraftSave<T>) => {
			setEdits((current) => commitEdits(current, save, saved, isEqual))
			setInFlight((current) => ({ ...save, base: current === null ? saved : current.base }))
		},
		[saved, isEqual],
	)

	const editsDirty = active !== null && active.committedOver === undefined && !isEqual(active.value, saved)
	return {
		draft,
		isDirty: editsDirty || (pending !== null && divergesFromSave(draft, pending, isEqual)),
		setDraft,
		updateDraft,
		discard,
		submit,
		abort,
		commit,
	}
}
