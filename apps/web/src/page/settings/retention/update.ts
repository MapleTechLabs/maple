import type * as Policy from "@maple/domain/policy"
import { type V2RetentionDays, type V2RetentionPolicy, V2RetentionUpdateParams } from "@maple/domain/http/v2"
import { RETENTION_SIGNALS } from "@maple/domain/retention"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { Array as Arr, Effect, Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { readClock } from "@maple/views/data/timing"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { PageOutMessage, type PageReturn } from "../../contract"
import { parsePeriod } from "../../kit/retention"
import { revisitData } from "../kit/revisit"
import { canManage, Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

const FetchRetention = Command.define("FetchRetention", {
	messages: [Message.CompletedFetchPolicy],
	execute: Effect.flatMap(MapleApiV2Client, (client) => client.retention.retrieve()).pipe(
		settleTo((result) => Message.CompletedFetchPolicy({ result })),
	),
})

const FetchSourceNames = Command.define("FetchRetentionSourceNames", {
	messages: [Message.CompletedFetchSources],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const sources = yield* collectV2Pages((cursor) =>
			client.sources.list({
				query: { limit: 100, ...(cursor !== undefined ? { cursor } : undefined) },
			}),
		)
		return Arr.map(sources, (source) => ({ id: source.id, name: source.name }))
	}).pipe(settleTo((result) => Message.CompletedFetchSources({ result }))),
})

const ReadRetentionClock = readClock("ReadRetentionClock", Message.ReadClock)

const SaveRetention = Command.define("SaveRetention", {
	args: { payload: V2RetentionUpdateParams },
	messages: [Message.CompletedSave],
	execute: ({ payload }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.retention.update({ payload })).pipe(
			settleTo((result) => Message.CompletedSave({ result })),
		),
})

export const init = (grants: ReadonlyArray<Policy.Permission>): Return => ({
	model: {
		grants,
		policy: AsyncData.Loading(),
		draft: null,
		isSaving: false,
		sourceNames: null,
		nowMs: null,
	},
	commands: [FetchRetention(), FetchSourceNames()],
})

export const revisit = (model: Model): Return => {
	const policy = revisitData(model.policy, FetchRetention)
	return { model: { ...model, policy: policy.data }, commands: [...policy.commands, FetchSourceNames()] }
}

/** What the organization keeps now, as stored. */
export const storedDays = (model: Model): V2RetentionDays | null =>
	Option.getOrNull(Option.map(AsyncData.getData(model.policy), (policy) => policy.organization.days))

/** The signals the draft changes from what is stored. */
export const changedSignals = (model: Model) => {
	const stored = storedDays(model)
	const draft = model.draft
	if (stored === null || draft === null) return []
	return Arr.filter(RETENTION_SIGNALS, (signal) => draft[signal] !== stored[signal])
}

/** The PATCH for the changed signals: the default is sent as `null`, so the signal inherits again. */
export const patchOf = (
	policy: V2RetentionPolicy,
	draft: V2RetentionDays,
	model: Model,
): V2RetentionUpdateParams => {
	const none: V2RetentionUpdateParams = {}
	return Arr.reduce(changedSignals(model), none, (patch, signal) => {
		const days = draft[signal]
		if (days === policy.defaults[signal]) return { ...patch, [signal]: null }
		return Option.match(parsePeriod(String(days)), {
			onNone: () => patch,
			onSome: (period) => ({ ...patch, [signal]: period }),
		})
	})
}

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchPolicy: ({ result }) => {
			const policy = AsyncData.settle(model.policy, result)
			// An untouched form follows what is stored; edits survive a refetch.
			const stored = Option.getOrNull(
				Option.map(AsyncData.getData(policy), (data) => data.organization.days),
			)
			const isDirty = changedSignals(model).length > 0
			return { model: { ...model, policy, draft: isDirty ? model.draft : stored } }
		},
		CompletedFetchSources: ({ result }) =>
			Result.match(result, {
				onSuccess: (sourceNames) => ({ model: { ...model, sourceNames } }),
				// The overrides list falls back to ids; the tab still works.
				onFailure: () => ({ model }),
			}),
		ClickedRetry: () => ({
			model: {
				...model,
				policy: AsyncData.Loading(),
			},
			commands: [FetchRetention(), ...(model.sourceNames === null ? [FetchSourceNames()] : [])],
		}),
		ChangedPeriod: ({ signal, value }) =>
			model.draft === null || !canManage(model)
				? { model }
				: Option.match(parsePeriod(value), {
						onNone: () => ({ model }),
						onSome: (days) => ({
							model:
								model.draft === null
									? model
									: { ...model, draft: { ...model.draft, [signal]: days } },
							commands: [ReadRetentionClock()],
						}),
					}),
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		ClickedDiscard: () => ({ model: { ...model, draft: storedDays(model) } }),
		ClickedSave: () => {
			const policy = Option.getOrNull(AsyncData.getData(model.policy))
			if (policy === null || model.draft === null || model.isSaving || !canManage(model))
				return { model }
			if (changedSignals(model).length === 0) return { model }
			return {
				model: { ...model, isSaving: true },
				commands: [SaveRetention({ payload: patchOf(policy, model.draft, model) })],
			}
		},
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: (policy) => ({
					model: {
						...model,
						isSaving: false,
						policy: AsyncData.Success({ data: policy }),
						draft: policy.organization.days,
					},
					outMessage: toast("success", "Retention saved"),
				}),
				onFailure: (error) => ({
					model: { ...model, isSaving: false },
					outMessage: toast("error", "Couldn't save retention", error.message),
				}),
			}),
	})
