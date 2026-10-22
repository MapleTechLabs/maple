import { type OrgClickHouseSettingsResponse, OrgClickHouseSettingsUpsertRequest } from "@maple/domain/http"
import { snapTimestamp } from "@maple/web-data/lib/time-range"
import { getServiceUsage } from "@maple/web-data/warehouse/service-usage"
import { Duration, Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import * as Dialog from "../../../ui/dialog"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import { type ConnectionDraft, Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

const settle =
	<A, B>(toMessage: (result: Result.Result<A, ReturnType<typeof toLoadFailure>>) => B) =>
	<E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(toLoadFailure), Effect.result, Effect.map(toMessage))

/** "Total in the DB": fixed bounds keep the key stable and cover all stored data. */
const ALL_TIME = {
	startTime: snapTimestamp("2000-01-01 00:00:00"),
	// Both bounds snap to 15 s, and the request carries the snapped values.
	endTime: snapTimestamp("2099-12-31 23:59:59"),
}

const FetchSettings = Command.define("FetchOrgClickHouseSettings", {
	messages: [Message.CompletedFetchSettings],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.orgClickHouseSettings.get()).pipe(
		settle((result) => Message.CompletedFetchSettings({ result })),
	),
})

const FetchDiff = Command.define("FetchOrgClickHouseSchemaDiff", {
	messages: [Message.CompletedFetchDiff],
	execute: Effect.flatMap(MapleInternalApiClient, (client) =>
		client.orgClickHouseSettings.schemaDiff(),
	).pipe(settle((result) => Message.CompletedFetchDiff({ result }))),
})

const FetchApplyStatus = Command.define("FetchOrgClickHouseApplyStatus", {
	args: { sequence: Schema.Number },
	messages: [Message.CompletedFetchApplyStatus],
	execute: ({ sequence }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.orgClickHouseSettings.applySchemaStatus(),
		).pipe(settle((result) => Message.CompletedFetchApplyStatus({ sequence, result }))),
})

const FetchUsage = Command.define("FetchDataPlatformUsage", {
	messages: [Message.CompletedFetchUsage],
	execute: getServiceUsage({ data: ALL_TIME }).pipe(
		Effect.map((response) =>
			response.data.reduce(
				(acc, service) => ({
					logs: acc.logs + service.totalLogs,
					traces: acc.traces + service.totalTraces,
					metrics: acc.metrics + service.totalMetrics,
					dataSize: acc.dataSize + service.dataSizeBytes,
				}),
				{ logs: 0, traces: 0, metrics: 0, dataSize: 0 },
			),
		),
		settle((result) => Message.CompletedFetchUsage({ result })),
	),
})

const SaveConnection = Command.define("SaveOrgClickHouseConnection", {
	args: { request: OrgClickHouseSettingsUpsertRequest },
	messages: [Message.CompletedSave],
	execute: ({ request }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.orgClickHouseSettings.upsert({ payload: request }),
		).pipe(settle((result) => Message.CompletedSave({ result }))),
})

const Disconnect = Command.define("DisconnectOrgClickHouse", {
	messages: [Message.CompletedDisconnect],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.orgClickHouseSettings.delete()).pipe(
		Effect.asVoid,
		settle((result) => Message.CompletedDisconnect({ result })),
	),
})

const ApplySchema = Command.define("ApplyOrgClickHouseSchema", {
	messages: [Message.CompletedApply],
	execute: Effect.flatMap(MapleInternalApiClient, (client) =>
		client.orgClickHouseSettings.applySchema(),
	).pipe(settle((result) => Message.CompletedApply({ result }))),
})

/** The button stays busy until the status poll reports the run (`setTimeout(…, 1500)`). */
const WaitStartingHandoff = Command.define("WaitSchemaApplyHandoff", {
	messages: [Message.ElapsedStartingHandoff],
	execute: Effect.as(Effect.sleep(Duration.millis(1500)), Message.ElapsedStartingHandoff()),
})

export const init = (): Return => ({
	model: {
		settings: AsyncData.Loading(),
		diff: AsyncData.Loading(),
		applyStatus: AsyncData.Idle(),
		applyStatusSent: 0,
		applyStatusAnswered: 0,
		usage: AsyncData.Loading(),
		draft: null,
		committedOver: null,
		password: "",
		isSaving: false,
		isDisconnecting: false,
		disconnectDialog: Dialog.init("data-platform-disconnect", "alert-dialog"),
		applyDialog: Dialog.init("data-platform-apply", "alert-dialog"),
		isStarting: false,
		showUpToDate: false,
		collapsedDrift: [],
	},
	commands: [FetchSettings(), FetchDiff(), FetchUsage()],
})

const toast = (type: "default" | "success" | "error" | "info", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const refresh = <A, E>(data: AsyncData.AsyncData<A, E>) =>
	Option.getOrElse(AsyncData.revalidate(data), () => data)

export const savedDraftOf = (settings: OrgClickHouseSettingsResponse): ConnectionDraft => ({
	url: settings.chUrl ?? "",
	user: settings.chUser ?? "default",
	database: settings.chDatabase ?? "default",
})

const sameDraft = (a: ConnectionDraft, b: ConnectionDraft) =>
	a.url === b.url && a.user === b.user && a.database === b.database

export const draftOf = (model: Model): ConnectionDraft =>
	model.draft ??
	AsyncData.getOrElse(AsyncData.map(model.settings, savedDraftOf), () => ({
		url: "",
		user: "default",
		database: "default",
	}))

export const isConnectionDirty = (model: Model): boolean =>
	model.password !== "" ||
	(model.draft !== null &&
		model.committedOver === null &&
		AsyncData.getOrElse(
			AsyncData.map(
				model.settings,
				(settings) => !sameDraft(savedDraftOf(settings), model.draft ?? savedDraftOf(settings)),
			),
			() => false,
		))

const isRunActive = (model: Model) =>
	AsyncData.getOrElse(
		AsyncData.map(
			model.applyStatus,
			(status) => status.status === "queued" || status.status === "running",
		),
		() => false,
	)

const liftDialog =
	(field: "disconnectDialog" | "applyDialog", wrap: (message: Dialog.Message) => Message) =>
	(model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
		model: { ...model, [field]: step.model },
		commands: Command.mapMessages(step.commands ?? [], wrap),
	})
const liftDisconnect = liftDialog("disconnectDialog", (message) =>
	Message.GotDisconnectDialogMessage({ message }),
)
const liftApply = liftDialog("applyDialog", (message) => Message.GotApplyDialogMessage({ message }))

/** One more apply-status read, numbered so its answer can be ordered against the others. */
const fetchApplyStatus = (model: Model): Return => {
	const sequence = model.applyStatusSent + 1
	return { model: { ...model, applyStatusSent: sequence }, commands: [FetchApplyStatus({ sequence })] }
}

/** `onChanged`: the connection and the diff are read again. */
const refreshConnection = (model: Model): Return => ({
	model: { ...model, settings: refresh(model.settings), diff: refresh(model.diff) },
	commands: [FetchSettings(), FetchDiff()],
})

const withCommands = (step: Return, commands: ReadonlyArray<Return["commands"]>): Return => ({
	...step,
	commands: [...(step.commands ?? []), ...commands.flatMap((list) => list ?? [])],
})

/** Back on the tab: the connection, drift and usage stay up while they load again. */
export const revisit = (model: Model): Return => {
	const settings = revisitData(model.settings, FetchSettings)
	const diff = revisitData(model.diff, FetchDiff)
	const usage = revisitData(model.usage, FetchUsage)
	// The apply poll only runs on the open tab: a run left in progress reads its status now.
	const next = { ...model, settings: settings.data, diff: diff.data, usage: usage.data }
	const applyStatus = AsyncData.isIdle(model.applyStatus) ? { model: next } : fetchApplyStatus(next)
	return {
		model: applyStatus.model,
		commands: [
			...settings.commands,
			...diff.commands,
			...usage.commands,
			...(applyStatus.commands ?? []),
		],
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchSettings: ({ result }) => {
			const settings = AsyncData.settle(model.settings, result)
			const fetched = Option.getOrNull(Option.map(AsyncData.getData(settings), savedDraftOf))
			// `isSaveSettled`: committed edits go once the saved value moves off its base or reaches them.
			const isSettled =
				model.committedOver !== null &&
				fetched !== null &&
				(!sameDraft(fetched, model.committedOver) ||
					(model.draft !== null && sameDraft(fetched, model.draft)))
			const next: Model = isSettled
				? { ...model, settings, draft: null, committedOver: null }
				: { ...model, settings }
			const isConfigured = AsyncData.getOrElse(
				AsyncData.map(settings, (doc) => doc.configured),
				() => false,
			)
			// `SchemaSection` mounts with the first configured answer and reads the apply status.
			return isConfigured && AsyncData.isIdle(model.applyStatus)
				? fetchApplyStatus({ ...next, applyStatus: AsyncData.Loading() })
				: { model: next }
		},
		CompletedFetchDiff: ({ result }) => ({
			model: { ...model, diff: AsyncData.settle(model.diff, result) },
		}),
		CompletedFetchApplyStatus: ({ sequence, result }) => {
			// A late "running" after a newer "succeeded" would restart the poll and toast again.
			if (sequence <= model.applyStatusAnswered) return { model }
			const previous = AsyncData.getOrElse(model.applyStatus, () => null)
			const applyStatus = AsyncData.settle(model.applyStatus, result)
			const next = { ...model, applyStatus, applyStatusAnswered: sequence }
			const wasRunning =
				previous !== null && (previous.status === "queued" || previous.status === "running")
			const current = AsyncData.getOrElse(applyStatus, () => null)
			if (!wasRunning || current === null) return { model: next }
			if (current.status === "succeeded")
				return { ...refreshConnection(next), outMessage: toast("success", "Schema applied") }
			if (current.status === "failed")
				return {
					model: next,
					outMessage: toast("error", "Schema apply failed", current.errorMessage ?? ""),
				}
			return { model: next }
		},
		CompletedFetchUsage: ({ result }) => ({
			model: { ...model, usage: AsyncData.settle(model.usage, result) },
		}),
		ChangedConnection: ({ field, value }) => ({
			model: { ...model, draft: { ...draftOf(model), [field]: value }, committedOver: null },
		}),
		ChangedPassword: ({ value }) => ({ model: { ...model, password: value } }),
		ClickedSave: () => {
			if (model.isSaving || model.isDisconnecting) return { model }
			const draft = draftOf(model)
			const sent = { url: draft.url.trim(), user: draft.user.trim(), database: draft.database.trim() }
			const request = new OrgClickHouseSettingsUpsertRequest({
				...sent,
				...(model.password !== "" && { password: model.password }),
			})
			return { model: { ...model, isSaving: true, draft }, commands: [SaveConnection({ request })] }
		},
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: () => {
					const base = AsyncData.getOrElse(AsyncData.map(model.settings, savedDraftOf), () =>
						draftOf(model),
					)
					const draft = draftOf(model)
					const committed = {
						...model,
						isSaving: false,
						password: "",
						committedOver: base,
						draft: {
							url: draft.url.trim(),
							user: draft.user.trim(),
							database: draft.database.trim(),
						},
					}
					return {
						...refreshConnection(committed),
						outMessage: toast("success", "Connection saved and tested"),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isSaving: false },
					outMessage: toast("error", "Connection test failed", error.message),
				}),
			}),
		ClickedDisconnect: () => liftDisconnect(model, Dialog.open(model.disconnectDialog)),
		GotDisconnectDialogMessage: ({ message: child }) =>
			model.isDisconnecting
				? { model }
				: liftDisconnect(model, Dialog.update(model.disconnectDialog, child)),
		ClickedConfirmDisconnect: () =>
			model.isDisconnecting
				? { model }
				: { model: { ...model, isDisconnecting: true }, commands: [Disconnect()] },
		CompletedDisconnect: ({ result }) => {
			const closed = liftDisconnect(
				{ ...model, isDisconnecting: false },
				Dialog.close(model.disconnectDialog),
			)
			return Result.match(result, {
				onSuccess: () => ({
					...withCommands(
						refreshConnection({
							...closed.model,
							password: "",
							draft: null,
							committedOver: null,
						}),
						[closed.commands],
					),
					outMessage: toast("success", "Disconnected"),
				}),
				onFailure: (error) => ({
					...closed,
					outMessage: toast("error", "Failed to disconnect", error.message),
				}),
			})
		},
		ClickedRefreshDiff: () => ({
			model: { ...model, diff: refresh(model.diff) },
			commands: [FetchDiff()],
		}),
		ToggledUpToDate: () => ({ model: { ...model, showUpToDate: !model.showUpToDate } }),
		ToggledDrift: ({ name }) => ({
			model: {
				...model,
				collapsedDrift: model.collapsedDrift.includes(name)
					? model.collapsedDrift.filter((entry) => entry !== name)
					: [...model.collapsedDrift, name],
			},
		}),
		ClickedReviewApply: () => liftApply(model, Dialog.open(model.applyDialog)),
		GotApplyDialogMessage: ({ message: child }) =>
			// Dismissal waits for the start; the close transition (fired while starting) still runs.
			model.isStarting && child._tag !== "GotAnimationMessage"
				? { model }
				: liftApply(model, Dialog.update(model.applyDialog, child)),
		ClickedConfirmApply: () => {
			if (model.isStarting || isRunActive(model)) return { model }
			const closed = liftApply({ ...model, isStarting: true }, Dialog.close(model.applyDialog))
			return withCommands(closed, [[ApplySchema()]])
		},
		CompletedApply: ({ result }) =>
			Result.match(result, {
				onSuccess: (started) => ({
					...withCommands(fetchApplyStatus({ ...model, applyStatus: refresh(model.applyStatus) }), [
						[WaitStartingHandoff()],
					]),
					outMessage:
						started.status === "already_running"
							? toast("info", "A schema apply is already in progress")
							: toast("default", "Schema apply started"),
				}),
				onFailure: (error) => ({
					model: { ...model, isStarting: false },
					outMessage: toast("error", "Failed to start schema apply", error.message),
				}),
			}),
		ElapsedStartingHandoff: () => ({ model: { ...model, isStarting: false } }),
		// A tick while a read is still out waits for it rather than racing it.
		TickedApplyPoll: () =>
			model.applyStatusSent > model.applyStatusAnswered ? { model } : fetchApplyStatus(model),
	})

export { isRunActive }
