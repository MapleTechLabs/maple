import { Schema } from "effect"

// A settings draft as pure state: the user's edits over a saved value, plus the save in flight. `saved` is
// always passed in.

export const DraftState = <S extends Schema.Top>(value: S) =>
	Schema.Struct({
		edits: Schema.NullOr(
			Schema.Struct({ value, committedOver: Schema.NullOr(Schema.Struct({ saved: value, sent: value })) }),
		),
		inFlight: Schema.NullOr(Schema.Struct({ submitted: value, sent: Schema.NullOr(value), base: value })),
	})

export interface DraftState<T> {
	readonly edits: {
		readonly value: T
		readonly committedOver: { readonly saved: T; readonly sent: T } | null
	} | null
	readonly inFlight: { readonly submitted: T; readonly sent: T | null; readonly base: T } | null
}

export type Equal<T> = (a: T, b: T) => boolean

export const emptyDraft = <T>(): DraftState<T> => ({ edits: null, inFlight: null })

/** Drops committed edits once `saved` caught up, and a save once `saved` moved (the render-phase resets). */
export const settle = <T>(state: DraftState<T>, saved: T, isEqual: Equal<T>): DraftState<T> => {
	const edits = state.edits
	const isEditsSettled =
		edits !== null &&
		edits.committedOver !== null &&
		(isEqual(edits.value, saved) ||
			isEqual(edits.committedOver.sent, saved) ||
			!isEqual(edits.committedOver.saved, saved))
	const save = state.inFlight
	const isSaveSettled =
		save !== null &&
		(!isEqual(save.base, saved) ||
			isEqual(save.submitted, saved) ||
			(save.sent !== null && isEqual(save.sent, saved)))
	return {
		edits: isEditsSettled ? null : edits,
		inFlight: isSaveSettled ? null : save,
	}
}

/** What the form shows: the edits, else the saved value. */
export const draftOf = <T>(state: DraftState<T>, saved: T): T => (state.edits === null ? saved : state.edits.value)

export const isDirty = <T>(state: DraftState<T>, saved: T, isEqual: Equal<T>): boolean => {
	const current = settle(state, saved, isEqual)
	const draft = draftOf(current, saved)
	const isEditsDirty =
		current.edits !== null && current.edits.committedOver === null && !isEqual(current.edits.value, saved)
	const save = current.inFlight
	const divergesFromSave =
		save !== null && !isEqual(draft, save.submitted) && (save.sent === null || !isEqual(draft, save.sent))
	return isEditsDirty || divergesFromSave
}

export const setDraft = <T>(state: DraftState<T>, next: T): DraftState<T> => ({
	...state,
	edits: { value: next, committedOver: null },
})

export const discard = <T>(): DraftState<T> => emptyDraft()

/** A save starts: records the draft it sends (`submit()`). */
export const submit = <T>(state: DraftState<T>, saved: T): DraftState<T> => ({
	...state,
	inFlight: { submitted: draftOf(state, saved), sent: null, base: saved },
})

/** A save failed: the edits stay as they are. */
export const abort = <T>(state: DraftState<T>): DraftState<T> => ({ ...state, inFlight: null })

/** A save stored `submitted` (normalized to `sent`): edits made since stay dirty. */
export const commit = <T>(
	state: DraftState<T>,
	save: { readonly submitted: T; readonly sent: T | null },
	saved: T,
	isEqual: Equal<T>,
): DraftState<T> => {
	const sent = save.sent ?? save.submitted
	const edits =
		state.edits === null
			? null
			: isEqual(state.edits.value, save.submitted)
				? { value: state.edits.value, committedOver: { saved, sent } }
				: { value: state.edits.value, committedOver: null }
	const base = state.inFlight === null ? saved : state.inFlight.base
	return { edits, inFlight: { submitted: save.submitted, sent: save.sent, base } }
}
