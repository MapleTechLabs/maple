import { Schema } from "effect"

// A provider's feature switches as the card edits them: each toggle saves at once and shows at
// once; a failed save puts the switch back and says why. The draft holds until the status re-read lands.

export const FeatureSwitchesModel = <S extends Schema.Top>(switches: S) =>
	Schema.Struct({
		/** What the switches show while a save is in flight or its status re-read is pending. */
		draft: Schema.NullOr(switches),
		isSaving: Schema.Boolean,
		error: Schema.NullOr(Schema.String),
	})

export type FeatureSwitchesState<A> = Readonly<{ draft: A | null; isSaving: boolean; error: string | null }>

export const initFeatureSwitches = { draft: null, isSaving: false, error: null } as const

/** The switches as shown: the draft while one is pending, else what is saved. */
export const shownSwitches = <A>(state: FeatureSwitchesState<A>, saved: A): A => state.draft ?? saved

/** A toggle: the new switches to save, or null while another save is in flight. */
export const toggledSwitches = <A>(
	state: FeatureSwitchesState<A>,
	saved: A,
	flip: (switches: A) => A,
): Readonly<{ state: FeatureSwitchesState<A>; save: A | null }> => {
	if (state.isSaving) return { state, save: null }
	const next = flip(shownSwitches(state, saved))
	return { state: { draft: next, isSaving: true, error: null }, save: next }
}

/** A save answered: a failure drops the draft (the switch goes back) and keeps the reason. */
export const completedSwitches = <A>(
	state: FeatureSwitchesState<A>,
	failure: string | null,
): FeatureSwitchesState<A> =>
	failure === null ? { ...state, isSaving: false } : { draft: null, isSaving: false, error: failure }

/** A status read landed: once no save is in flight, the saved switches take over again. */
export const settledSwitches = <A>(state: FeatureSwitchesState<A>): FeatureSwitchesState<A> =>
	state.isSaving || state.draft === null ? state : { ...state, draft: null }
