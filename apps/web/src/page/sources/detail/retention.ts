import type { V2RetentionPolicy, V2Source, V2SourceRetentionUpdateParams } from "@maple/domain/http/v2"
import { RETENTION_SIGNALS, type RetentionSignal } from "@maple/domain/retention"
import type { SourceId } from "@maple/primitives"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { RetentionForm, RetentionSet } from "./model"

// The Settings tab's Retention section: what this source keeps, as stored and as edited.

/** A select's value for following the organization. */
export const INHERIT = "inherit"

const NOTHING_SET: RetentionSet = {
	traces: null,
	logs: null,
	metrics: null,
	sessions: null,
	events: null,
	profiles: null,
}

export const initRetention = (): RetentionForm => ({
	policy: AsyncData.Loading(),
	draft: null,
	isSaving: false,
	savedWithSource: false,
	savedAlongside: false,
})

/** What `sourceId` sets, as stored: a source the policy does not list follows the organization. */
export const storedSet = (policy: V2RetentionPolicy, sourceId: SourceId): RetentionSet =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(policy.sources, (source) => source.source_id === sourceId),
			(source) => source.set,
		),
		() => NOTHING_SET,
	)

/** The signals a source can send: `null` allows every one. */
export const signalsOf = (source: V2Source): ReadonlyArray<RetentionSignal> =>
	source.allowed_signals === null
		? RETENTION_SIGNALS
		: Arr.filter(RETENTION_SIGNALS, (signal) => source.allowed_signals?.includes(signal) === true)

/** The period a signal keeps: the source's own, else the organization's. */
export const effectiveDays = (
	policy: V2RetentionPolicy,
	set: RetentionSet,
	signal: RetentionSignal,
): number => set[signal] ?? policy.organization.days[signal]

/** The signals the draft changes from what is stored. */
export const changedRetentionSignals = (
	form: RetentionForm | null,
	sourceId: SourceId | null,
): ReadonlyArray<RetentionSignal> => {
	if (form === null || form.draft === null || sourceId === null) return []
	const draft = form.draft
	return Option.match(AsyncData.getData(form.policy), {
		onNone: () => [],
		onSome: (policy) => {
			const stored = storedSet(policy, sourceId)
			return Arr.filter(RETENTION_SIGNALS, (signal) => draft[signal] !== stored[signal])
		},
	})
}

/** The PATCH for the changed signals: `null` follows the organization again. */
export const retentionPatch = (form: RetentionForm, sourceId: SourceId): V2SourceRetentionUpdateParams => {
	const draft = form.draft
	const none: V2SourceRetentionUpdateParams = {}
	if (draft === null) return none
	return Arr.reduce(changedRetentionSignals(form, sourceId), none, (patch, signal) => ({
		...patch,
		[signal]: draft[signal],
	}))
}

/** The draft as stored again, once the policy has loaded. */
export const resetRetention = (form: RetentionForm, sourceId: SourceId): RetentionForm => ({
	...form,
	draft: Option.getOrNull(
		Option.map(AsyncData.getData(form.policy), (policy) => storedSet(policy, sourceId)),
	),
})
