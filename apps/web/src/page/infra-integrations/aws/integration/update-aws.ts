import type { V2AwsConnection, V2AwsIngest, V2AwsIntegration, V2AwsSetup } from "@maple/domain/http/v2"
import type { AwsConnectionId, AwsMetricNamespace, AwsModule } from "@maple/primitives"
import { Option, type Result, Array as Arr } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import type { PageContext } from "../../../contract"
import {
	type AwsCardModel,
	AwsMessage,
	type AwsRemovedStack,
	type AwsMetricsEdit,
	type AwsSelection,
	isMetricsPanelOpen,
	type AwsSetupMethod,
	type AwsSetupPart,
	CheckAwsConnection,
	CreateAwsConnection,
	DeleteAwsConnection,
	decodeCreateRequest,
	LoadAwsIngest,
	LoadAwsSetup,
	METRIC_SELECTION_HINT,
	metricStreamOf,
	normalizeAccountId,
	offeredModule,
	pendingConnections,
	ReadAwsRemoved,
	selectionOf,
	UpdateAwsMetricStream,
	UpdateAwsModules,
	WriteAwsRemoved,
} from "./aws"
import { disconnectSpec } from "../../../integrations/disconnect"
import type { Model } from "../../../integrations/model"
import {
	HubRequest,
	type ProviderEnv,
	type ProviderReturn,
	type ProviderUpdate,
	type StatusAnswer,
} from "../../../integrations/provider"

// The AWS card's state changes, as the AWS module's update.

type Status = V2AwsIntegration
type Env = ProviderEnv<Status>
type Return = ProviderReturn<AwsCardModel, AwsMessage>
type Slot = Env["status"]

const withCard = (model: AwsCardModel, card: Partial<AwsCardModel>): AwsCardModel => ({ ...model, ...card })

/** Runs steps in order: the last step's model, every request and Command in order. */
const steps = (model: AwsCardModel, next: ReadonlyArray<(model: AwsCardModel) => Return>): Return =>
	Arr.reduce<(typeof next)[number], Return>(next, { model }, (acc, step) => {
		const result = step(acc.model)
		return {
			model: result.model,
			requests: [...(acc.requests ?? []), ...(result.requests ?? [])],
			commands: [...(acc.commands ?? []), ...(result.commands ?? [])],
		}
	})

const toast = (model: AwsCardModel, type: "success" | "error", title: string, description = ""): Return => ({
	model,
	requests: [HubRequest.toast(type, title, description)],
})

const readStatus =
	(mode: Keyed.ReadMode) =>
	(model: AwsCardModel): Return => ({
		model,
		requests: [HubRequest.readStatus(mode)],
	})

const readClock = (model: AwsCardModel): Return => ({ model, requests: [HubRequest.readClock()] })

const statusIn = (slot: Slot): Status | null => Option.getOrNull(AsyncData.getData(slot.data))

const connectionsIn = (slot: Slot): ReadonlyArray<V2AwsConnection> => statusIn(slot)?.connections ?? []

/** The AWS connections the page holds, for the views and Sources. */
export const connectionsOf = (model: Model): ReadonlyArray<V2AwsConnection> =>
	connectionsIn(model.statuses.aws)

const flip = <A>(values: ReadonlyArray<A>, value: A): ReadonlyArray<A> =>
	values.includes(value) ? Arr.filter(values, (entry) => entry !== value) : [...values, value]

const gotAccountId = (model: AwsCardModel, message: Field.Message): Return => {
	const step = Field.update(model.accountId, message)
	return {
		model: withCard(model, { accountId: step.model, createError: null }),
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			AwsMessage.GotAwsAccountIdMessage({ message: inner }),
		),
	}
}

/** The role comes first: the metric stream is picked once Maple can see the account. */
const submittedAccount = (model: AwsCardModel, env: Env): Return => {
	if (model.isCreating) return { model }
	// Only what the org is offered is asked for: the API refuses a module it is not.
	const modules = Arr.filter(model.newModules, (module) =>
		Option.isSome(offeredModule(statusIn(env.status), module)),
	)
	const request = {
		account_id: normalizeAccountId(model.accountId.value),
		...(modules.length > 0 && { modules }),
	}
	return Option.match(decodeCreateRequest(request), {
		onNone: () => ({ model: withCard(model, { createError: "An AWS account ID is 12 digits." }) }),
		onSome: (request) => ({
			model: withCard(model, { isCreating: true, createError: null }),
			commands: [CreateAwsConnection({ request })],
		}),
	})
}

/** The new connection's setup opens right away: deploying the stack is the next step. */
const succeededCreate = (model: AwsCardModel, env: Env, connection: V2AwsConnection): Return =>
	steps(
		withCard(model, {
			accountId: Field.init(),
			isCreating: false,
			isAdding: false,
			flowId: connection.id,
		}),
		[(next) => openSetup(next, env, connection.id), readStatus("Supersede")],
	)

const setupKey = (context: PageContext, id: AwsConnectionId) =>
	requestKey(context.orgId, "awsIntegration.setup", { id })

const openSetup = (
	model: AwsCardModel,
	env: Env,
	id: AwsConnectionId,
	mode: Keyed.ReadMode = "Load",
): Return => {
	// Another connection's setup is never shown while this one loads: its stack is for another account.
	const opened = withCard(
		model,
		model.setupId === id ? { setupId: id, flowId: id } : { setupId: id, flowId: id, setup: Keyed.idle() },
	)
	return Option.match(Keyed.requestFor(opened.setup, setupKey(env.context, id), mode), {
		onNone: () => ({ model: opened }),
		onSome: (requested) => ({
			model: withCard(opened, { setup: requested }),
			commands: [LoadAwsSetup({ key: requested.key, id })],
		}),
	})
}

const completedLoadSetup = (
	model: AwsCardModel,
	key: string,
	result: Result.Result<V2AwsSetup, LoadFailure>,
): Return => ({ model: withCard(model, { setup: Keyed.accept(model.setup, key, result) }) })

const setMethod = (model: AwsCardModel, part: AwsSetupPart, method: AwsSetupMethod): Return => ({
	model: withCard(model, part === "role" ? { method } : { streamMethod: method }),
})

/** A click during a background check makes that check the user's: its result is toasted. */
const startCheck = (model: AwsCardModel, id: AwsConnectionId, quiet: boolean): Return => {
	const checking = model.checking
	if (!Arr.some(checking, (entry) => entry.id === id)) {
		return {
			model: withCard(model, { checking: [...checking, { id, quiet }] }),
			commands: [CheckAwsConnection({ id, quiet })],
		}
	}
	return quiet
		? { model }
		: {
				model: withCard(model, {
					checking: Arr.map(checking, (entry) => (entry.id === id ? { id, quiet: false } : entry)),
				}),
			}
}

/** Every connection still waiting for its stack is checked again, without a toast. */
const tickedPending = (model: AwsCardModel, env: Env): Return => {
	const status = statusIn(env.status)
	return steps(
		model,
		Arr.map(
			status === null ? [] : pendingConnections(status),
			(connection) => (next: AwsCardModel) => startCheck(next, connection.id, true),
		),
	)
}

const completedCheck = (
	model: AwsCardModel,
	env: Env,
	id: AwsConnectionId,
	sentQuiet: boolean,
	connection: V2AwsConnection | null,
	failure: LoadFailure | null,
): Return => {
	const quiet = Arr.findFirst(model.checking, (entry) => entry.id === id).pipe(
		Option.flatMapNullishOr((found) => found.quiet),
		Option.getOrElse(() => sentQuiet),
	)
	const settled = withCard(model, { checking: Arr.filter(model.checking, (entry) => entry.id !== id) })
	if (failure !== null) {
		return quiet
			? { model: settled }
			: toast(settled, "error", "Couldn't check the AWS connection", failure.message)
	}
	const justVerified =
		Option.exists(
			Arr.findFirst(connectionsIn(env.status), (entry) => entry.id === id),
			(before) => before.verified_at === null,
		) && connection?.verified_at != null
	// Only the open setup's own connection closes it: a background check may verify another.
	const isOpen = model.setupId === id
	return steps(settled, [
		// A check lands after the page read its clock: "checked" would read as in the future.
		readClock,
		readStatus("Supersede"),
		(next) =>
			justVerified && (isOpen || !quiet)
				? toast(
						withCard(next, isOpen ? { setupId: null } : {}),
						"success",
						"AWS connected",
						`Maple can read account ${connection.account_id}.`,
					)
				: quiet || connection === null
					? { model: next }
					: toast(
							next,
							connection.last_check_error === null ? "success" : "error",
							connection.last_check_error === null ? "Connection works" : "The check failed",
							connection.last_check_error ?? "",
						),
	])
}

const gotCopy = (model: AwsCardModel, id: string, message: CopyButton.Message): Return => {
	const step = CopyButton.update(model.copies[id] ?? CopyButton.init(), message)
	return {
		model: withCard(model, { copies: { ...model.copies, [id]: step.model } }),
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			AwsMessage.GotAwsCopyMessage({ id, message: inner }),
		),
	}
}

const dialogStep = (model: AwsCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { disconnectDialog: step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		AwsMessage.GotAwsDisconnectDialogMessage({ message }),
	),
})

const confirmedDisconnect = (model: AwsCardModel, env: Env): Return => {
	const id = model.disconnectId
	const found = Arr.findFirst(connectionsIn(env.status), (entry) => entry.id === id)
	if (id === null || Option.isNone(found) || model.isDisconnecting) return { model }
	return {
		model: withCard(model, { isDisconnecting: true }),
		commands: [DeleteAwsConnection({ id, accountId: found.value.account_id })],
	}
}

/**
 * The stack stays in AWS until an administrator deletes it: its cleanup script takes its place.
 * Only this connection's own dialog and setup close: another may have opened meanwhile.
 */
const completedDisconnect = (
	model: AwsCardModel,
	env: Env,
	id: AwsConnectionId,
	removed: AwsRemovedStack | null,
	error: string | null,
): Return => {
	const settled = withCard(model, { isDisconnecting: false })
	if (removed === null) return toast(settled, "error", disconnectSpec("aws").error, error ?? "")
	const stacks = [
		removed,
		...Arr.filter(settled.removed, (stack) => stack.connectionId !== removed.connectionId),
	]
	return steps(
		// `disconnectId` stays: the closing dialog still names the account.
		withCard(settled, {
			removed: stacks,
			setupId: settled.setupId === id ? null : settled.setupId,
			flowId: settled.flowId === id ? null : settled.flowId,
		}),
		[
			(next) =>
				next.disconnectId === id
					? dialogStep(next, Dialog.close(next.disconnectDialog))
					: { model: next },
			(next) => ({
				model: next,
				commands: [WriteAwsRemoved({ orgId: env.context.orgId, removed: stacks })],
			}),
			(next) =>
				toast(
					next,
					"success",
					disconnectSpec("aws").success,
					"Delete the stack in AWS to remove the role.",
				),
			readStatus("Supersede"),
			(next) => ({ model: next, requests: [HubRequest.trackDisconnected("aws")] }),
		],
	)
}

const dismissedRemoved = (model: AwsCardModel, env: Env, connectionId: string): Return => {
	const removed = Arr.filter(model.removed, (stack) => stack.connectionId !== connectionId)
	return {
		model: withCard(model, { removed }),
		commands: [WriteAwsRemoved({ orgId: env.context.orgId, removed })],
	}
}

/** The removed stacks this browser kept for the org, read when the card mounts. */
export const enterAws = (model: AwsCardModel, env: Env): Return => ({
	model,
	commands: [ReadAwsRemoved({ orgId: env.context.orgId })],
})

const ingestKey = (context: PageContext, id: AwsConnectionId) =>
	requestKey(context.orgId, "awsIntegration.ingest", { id })

/**
 * The ingest of each verified streaming connection, only where the AWS card shows it: a status
 * read loads what is missing, the card's watch refreshes it.
 */
const requestIngest = (model: AwsCardModel, env: Env, mode: Keyed.ReadMode): Return =>
	steps(
		model,
		Arr.map(
			Arr.filter(
				env.isShown ? connectionsIn(env.status) : [],
				(connection) => connection.verified_at !== null && connection.metric_stream !== null,
			),
			(connection) => (next: AwsCardModel) => {
				const slot = next.ingest[connection.id] ?? Keyed.idle()
				return Option.match(Keyed.requestFor(slot, ingestKey(env.context, connection.id), mode), {
					onNone: () => ({ model: next }),
					onSome: (requested) => ({
						model: withCard(next, { ingest: { ...next.ingest, [connection.id]: requested } }),
						commands: [LoadAwsIngest({ key: requested.key, id: connection.id })],
					}),
				})
			},
		),
	)

const completedIngest = (
	model: AwsCardModel,
	id: AwsConnectionId,
	key: string,
	result: Result.Result<V2AwsIngest, LoadFailure>,
): Return => {
	const slot = model.ingest[id]
	if (slot === undefined) return { model }
	return { model: withCard(model, { ingest: { ...model.ingest, [id]: Keyed.accept(slot, key, result) } }) }
}

/**
 * A status read can verify the open setup before any check of this page does (the hourly check,
 * another tab): the setup closes then too.
 */
export const statusArrived = (model: AwsCardModel, env: Env, answer: StatusAnswer<Status>): Return => {
	const setupId = model.setupId
	const wasUnverified = Option.exists(
		Arr.findFirst(connectionsIn(answer.previous), (entry) => entry.id === setupId),
		(entry) => entry.verified_at === null,
	)
	const verified = Option.filter(
		Arr.findFirst(connectionsIn(env.status), (entry) => entry.id === setupId),
		(entry) => entry.verified_at !== null,
	)
	return steps(model, [
		(next) => requestIngest(next, env, "Load"),
		(next) =>
			Option.match(wasUnverified ? verified : Option.none(), {
				onNone: () => ({ model: next }),
				onSome: (now) =>
					toast(
						withCard(next, { setupId: null }),
						"success",
						"AWS connected",
						`Maple can read account ${now.account_id}.`,
					),
			}),
	])
}

/** A setup is open for a connection whose stack Maple has not assumed yet. */
export const isAwsPending = (model: AwsCardModel, slot: Slot): boolean =>
	model.setupId !== null &&
	Arr.some(
		connectionsIn(slot),
		(connection) => connection.id === model.setupId && connection.verified_at === null,
	)

/** A verified connection streams metrics: its deliveries and what they stored keep moving. */
export const isAwsStreaming = (slot: Slot): boolean =>
	Arr.some(
		connectionsIn(slot),
		(connection) => connection.verified_at !== null && connection.metric_stream !== null,
	)

/** Edit data: the picker opens with what the connection streams. */
const clickedMetrics = (model: AwsCardModel, id: AwsConnectionId): Return => {
	const edit = model.metrics
	const selection = edit._tag === "Editing" && edit.id === id ? edit.selection : null
	return {
		model: withCard(model, {
			metrics: { _tag: "Editing", id, selection, isPanelOpen: true, error: null },
		}),
	}
}

/** One region or namespace in or out of what the connection would stream; held while it saves. */
const toggled = (
	model: AwsCardModel,
	env: Env,
	id: AwsConnectionId,
	change: (selection: AwsSelection) => AwsSelection,
): Return => {
	const edit = model.metrics
	const found = Arr.findFirst(connectionsIn(env.status), (entry) => entry.id === id)
	if (Option.isNone(found) || edit._tag === "Saving") return { model }
	const selection = change(selectionOf(found.value, edit))
	return {
		model: withCard(model, {
			metrics: {
				_tag: "Editing",
				id,
				selection,
				isPanelOpen: isMetricsPanelOpen(edit, id),
				error: null,
			},
		}),
	}
}

const toggledNamespace = (
	model: AwsCardModel,
	env: Env,
	id: AwsConnectionId,
	namespace: AwsMetricNamespace,
): Return =>
	toggled(model, env, id, (selection) => ({
		...selection,
		namespaces: flip(selection.namespaces, namespace),
	}))

const submittedMetrics = (model: AwsCardModel, env: Env, id: AwsConnectionId): Return => {
	const edit = model.metrics
	const found = Arr.findFirst(connectionsIn(env.status), (entry) => entry.id === id)
	if (Option.isNone(found) || edit._tag === "Saving") return { model }
	const selection = selectionOf(found.value, edit)
	const isPanelOpen = isMetricsPanelOpen(edit, id)
	return Option.match(metricStreamOf(selection), {
		onNone: () => ({
			model: withCard(model, {
				metrics: { _tag: "Editing", id, selection, isPanelOpen, error: METRIC_SELECTION_HINT },
			}),
		}),
		onSome: (metricStream) => ({
			model: withCard(model, { metrics: { _tag: "Saving", id, selection, isPanelOpen } }),
			commands: [UpdateAwsMetricStream({ id, metricStream })],
		}),
	})
}

/**
 * AWS only streams once the stack is deployed again, so its setup opens right away. A result for a
 * save the editor moved on from only reports, as a toast.
 */
const completedMetricStream = (
	model: AwsCardModel,
	env: Env,
	id: AwsConnectionId,
	connection: V2AwsConnection | null,
	error: string | null,
): Return => {
	const done = (next: AwsCardModel) =>
		toast(next, "success", "Metric stream added", "Run the setup again in AWS to start streaming.")
	const edit = model.metrics
	if (edit._tag !== "Saving" || edit.id !== id)
		return connection === null
			? toast(model, "error", "Couldn't turn on the metric stream", error ?? "")
			: steps(model, [readStatus("Supersede"), done])
	const { selection, isPanelOpen } = edit
	if (connection === null)
		return { model: withCard(model, { metrics: { _tag: "Editing", id, selection, isPanelOpen, error } }) }
	// The pick stays, panel closed, so the flow shows it until the status read brings the stream back.
	const saved: AwsMetricsEdit = { _tag: "Editing", id, selection, isPanelOpen: false, error: null }
	return steps(withCard(model, { metrics: saved }), [
		// The stored script predates the stream, so it is read again.
		(next) => openSetup(next, env, connection.id, "Supersede"),
		readStatus("Supersede"),
		done,
	])
}

/** One module in or out of what the connection asks for; its other modules are kept. */
const toggledModule = (model: AwsCardModel, env: Env, id: AwsConnectionId, module: AwsModule): Return => {
	const found = Arr.findFirst(connectionsIn(env.status), (entry) => entry.id === id)
	if (Option.isNone(found) || !env.canManage || model.moduleSave._tag === "Saving") return { model }
	return {
		model: withCard(model, { moduleSave: { _tag: "Saving", id, module } }),
		commands: [UpdateAwsModules({ id, modules: flip(found.value.modules, module) })],
	}
}

/**
 * The role follows only once the stack is deployed again, so its setup opens with the new script,
 * as after a metric stream change. A refusal stays on the row and leaves the switch as it was.
 * The answered connection takes its place in the status, so the switch does not wait for the re-read.
 */
const completedModules = (
	model: AwsCardModel,
	env: Env,
	id: AwsConnectionId,
	connection: V2AwsConnection | null,
	error: string | null,
): ProviderUpdate<AwsCardModel, AwsMessage, Status> => {
	const save = model.moduleSave
	if (connection === null)
		return {
			model: withCard(model, {
				moduleSave:
					save._tag === "Saving" && save.id === id
						? {
								_tag: "Refused",
								id,
								module: save.module,
								error: error ?? "Couldn't change what Maple reads.",
							}
						: { _tag: "Idle" },
			}),
		}
	const before = Arr.findFirst(connectionsIn(env.status), (entry) => entry.id === id)
	const changed = Arr.findFirst(
		statusIn(env.status)?.modules ?? [],
		(info) =>
			connection.modules.includes(info.module) !==
			Option.exists(before, (entry) => entry.modules.includes(info.module)),
	)
	const step = steps(withCard(model, { moduleSave: { _tag: "Idle" } }), [
		(next) => openSetup(next, env, connection.id, "Supersede"),
		readStatus("Supersede"),
		(next) =>
			Option.match(changed, {
				onNone: () => ({ model: next }),
				onSome: (info) =>
					connection.modules.includes(info.module)
						? toast(
								next,
								"success",
								`${info.title} turned on`,
								"Run the setup again in AWS to grant it.",
							)
						: toast(
								next,
								"success",
								`${info.title} turned off`,
								"Run the setup again in AWS to remove its policy.",
							),
			}),
	])
	return {
		...step,
		status: (status) => ({
			...status,
			connections: Arr.map(status.connections, (entry) =>
				entry.id === connection.id ? connection : entry,
			),
		}),
	}
}

export const update = (
	model: AwsCardModel,
	message: AwsMessage,
	env: Env,
): ProviderUpdate<AwsCardModel, AwsMessage, Status> =>
	AwsMessage.match<ProviderUpdate<AwsCardModel, AwsMessage, Status>>(message, {
		GotAwsAccountIdMessage: ({ message: child }) => gotAccountId(model, child),
		SubmittedAwsAccount: () => submittedAccount(model, env),
		SucceededAwsCreate: ({ connection }) => succeededCreate(model, env, connection),
		FailedAwsCreate: ({ error }) => ({
			model: withCard(model, { isCreating: false, createError: error }),
		}),
		ClickedAwsAdd: () => ({
			model: withCard(model, { isAdding: true, createError: null, newModules: [] }),
		}),
		ClickedAwsAddCancel: () => ({
			model: withCard(model, { isAdding: false, createError: null, newModules: [] }),
		}),
		ClickedAwsSetup: ({ id }) => openSetup(model, env, id),
		ClickedAwsSetupClose: () => ({ model: withCard(model, { setupId: null }) }),
		CompletedLoadAwsSetup: ({ key, result }) => completedLoadSetup(model, key, result),
		CompletedLoadAwsIngest: ({ id, key, result }) => completedIngest(model, id, key, result),
		ClickedAwsSetupMethod: ({ part, method }) => setMethod(model, part, method),
		ClickedAwsCheck: ({ id }) => startCheck(model, id, false),
		TickedAwsPending: () => tickedPending(model, env),
		// The status is read again, and with it each stream's ingest; the clock moves "last delivery" along.
		TickedAwsWatch: () =>
			steps(model, [readClock, readStatus("Refresh"), (next) => requestIngest(next, env, "Refresh")]),
		CompletedAwsCheck: ({ id, quiet, connection, failure }) =>
			completedCheck(model, env, id, quiet, connection, failure),
		GotAwsCopyMessage: ({ id, message: child }) => gotCopy(model, id, child),
		ClickedAwsDisconnect: ({ id }) =>
			dialogStep(withCard(model, { disconnectId: id }), Dialog.open(model.disconnectDialog)),
		GotAwsDisconnectDialogMessage: ({ message: child }) =>
			dialogStep(model, Dialog.update(model.disconnectDialog, child)),
		ConfirmedAwsDisconnect: () => confirmedDisconnect(model, env),
		CompletedAwsDisconnect: ({ id, removed, error }) =>
			completedDisconnect(model, env, id, removed, error),
		DismissedAwsRemoved: ({ connectionId }) => dismissedRemoved(model, env, connectionId),
		CompletedReadAwsRemoved: ({ removed }) => ({ model: withCard(model, { removed }) }),
		CompletedWriteAwsRemoved: () => ({ model }),
		ClickedAwsMetrics: ({ id }) => clickedMetrics(model, id),
		// Closes the panel; a save in flight still answers, as a toast.
		ClickedAwsMetricsCancel: () => ({ model: withCard(model, { metrics: { _tag: "Idle" } }) }),
		ToggledAwsRegion: ({ id, region }) =>
			toggled(model, env, id, (selection) => ({
				...selection,
				regions: flip(selection.regions, region),
			})),
		ToggledAwsNamespace: ({ id, namespace }) => toggledNamespace(model, env, id, namespace),
		SubmittedAwsMetrics: ({ id }) => submittedMetrics(model, env, id),
		CompletedAwsMetricStream: ({ id, connection, error }) =>
			completedMetricStream(model, env, id, connection, error),
		ToggledAwsModule: ({ id, module }) => toggledModule(model, env, id, module),
		CompletedAwsModules: ({ id, connection, error }) =>
			completedModules(model, env, id, connection, error),
		ToggledAwsNewModule: ({ module }) =>
			model.isCreating
				? { model }
				: { model: withCard(model, { newModules: flip(model.newModules, module) }) },
	})
