import type { V2AwsConnection, V2AwsIngest, V2AwsSetup } from "@maple/domain/http/v2"
import type { AwsConnectionId, AwsMetricNamespace } from "@maple/domain/primitives"
import { Option, type Result } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { requestKey } from "../../data/request-key"
import * as CopyButton from "../../ui/copy-button"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import {
	type AwsCardModel,
	type AwsRemovedStack,
	type AwsSelection,
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
	pendingConnections,
	ReadAwsRemoved,
	selectionOf,
	UpdateAwsMetricStream,
	WriteAwsRemoved,
} from "./aws"
import { integrationOfSearch } from "./catalog"
import { ReadClock } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { chain, requestStatus } from "./update-status"

// `AwsIntegrationCard`'s state changes.

type Return = PageReturn<Model, Message>

const withCard = (model: Model, card: Partial<AwsCardModel>): Model => ({
	...model,
	awsCard: { ...model.awsCard, ...card },
})

const toast = (model: Model, type: "success" | "error", title: string, description = ""): Return => ({
	model,
	outMessage: PageOutMessage.RequestedToast({ type, title, description }),
})

export const connectionsOf = (model: Model): ReadonlyArray<V2AwsConnection> =>
	Option.match(AsyncData.getData(model.statuses.aws.data), {
		onNone: () => [],
		onSome: (status) => status.connections,
	})

export const gotAccountId = (model: Model, message: Field.Message): Return => {
	const step = Field.update(model.awsCard.accountId, message)
	return {
		model: withCard(model, { accountId: step.model, createError: null }),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotAwsAccountIdMessage({ message: inner }),
		),
	}
}

/** The role comes first: the metric stream is picked once Maple can see the account. */
export const submittedAccount = (model: Model): Return => {
	const card = model.awsCard
	if (card.isCreating) return { model }
	return Option.match(decodeCreateRequest({ account_id: normalizeAccountId(card.accountId.value) }), {
		onNone: () => ({ model: withCard(model, { createError: "An AWS account ID is 12 digits." }) }),
		onSome: (request) => ({
			model: withCard(model, { isCreating: true, createError: null }),
			commands: [CreateAwsConnection({ request })],
		}),
	})
}

/** The new connection's setup opens right away: deploying the stack is the next step. */
export const succeededCreate = (model: Model, context: PageContext, connection: V2AwsConnection): Return =>
	chain(
		withCard(model, {
			accountId: Field.init(),
			isCreating: false,
			isAdding: false,
			flowId: connection.id,
		}),
		[
			(next) => openSetup(next, context, connection.id),
			(next) => requestStatus(next, context, "aws", "Supersede"),
		],
	)

export const failedCreate = (model: Model, error: string): Return => ({
	model: withCard(model, { isCreating: false, createError: error }),
})

export const setAdding = (model: Model, isAdding: boolean): Return => ({
	model: withCard(model, { isAdding, createError: null }),
})

const setupKey = (context: PageContext, id: AwsConnectionId) =>
	requestKey(context.orgId, "awsIntegration.setup", { id })

export const openSetup = (
	model: Model,
	context: PageContext,
	id: AwsConnectionId,
	mode: Keyed.ReadMode = "Load",
): Return => {
	// Another connection's setup is never shown while this one loads: its stack is for another account.
	const opened = withCard(
		model,
		model.awsCard.setupId === id
			? { setupId: id, flowId: id }
			: { setupId: id, flowId: id, setup: Keyed.idle() },
	)
	return Option.match(Keyed.requestFor(opened.awsCard.setup, setupKey(context, id), mode), {
		onNone: () => ({ model: opened }),
		onSome: (requested) => ({
			model: withCard(opened, { setup: requested }),
			commands: [LoadAwsSetup({ key: requested.key, id })],
		}),
	})
}

export const closeSetup = (model: Model): Return => ({ model: withCard(model, { setupId: null }) })

export const completedLoadSetup = (
	model: Model,
	key: string,
	result: Result.Result<V2AwsSetup, LoadFailure>,
): Return => ({ model: withCard(model, { setup: Keyed.accept(model.awsCard.setup, key, result) }) })

export const setMethod = (model: Model, part: AwsSetupPart, method: AwsSetupMethod): Return => ({
	model: withCard(model, part === "role" ? { method } : { streamMethod: method }),
})

/** A click during a background check makes that check the user's: its result is toasted. */
const startCheck = (model: Model, id: AwsConnectionId, quiet: boolean): Return => {
	const checking = model.awsCard.checking
	if (!checking.some((entry) => entry.id === id)) {
		return {
			model: withCard(model, { checking: [...checking, { id, quiet }] }),
			commands: [CheckAwsConnection({ id, quiet })],
		}
	}
	return quiet
		? { model }
		: {
				model: withCard(model, {
					checking: checking.map((entry) => (entry.id === id ? { id, quiet: false } : entry)),
				}),
			}
}

export const clickedCheck = (model: Model, id: AwsConnectionId): Return => startCheck(model, id, false)

/** Every connection still waiting for its stack is checked again, without a toast. */
export const tickedPending = (model: Model): Return =>
	chain(
		model,
		Option.match(AsyncData.getData(model.statuses.aws.data), {
			onNone: () => [],
			onSome: (status) =>
				pendingConnections(status).map(
					(connection) => (next: Model) => startCheck(next, connection.id, true),
				),
		}),
	)

export const completedCheck = (
	model: Model,
	context: PageContext,
	id: AwsConnectionId,
	sentQuiet: boolean,
	connection: V2AwsConnection | null,
	failure: LoadFailure | null,
): Return => {
	const quiet = model.awsCard.checking.find((entry) => entry.id === id)?.quiet ?? sentQuiet
	const settled = withCard(model, { checking: model.awsCard.checking.filter((entry) => entry.id !== id) })
	if (failure !== null) {
		return quiet
			? { model: settled }
			: toast(settled, "error", "Failed to check the AWS connection", failure.message)
	}
	const before = connectionsOf(model).find((entry) => entry.id === id)
	const justVerified = before?.verified_at === null && connection?.verified_at != null
	// Only the open setup's own connection closes it: a background check may verify another.
	const isOpen = model.awsCard.setupId === id
	return chain(settled, [
		// A check lands after the page read its clock: "checked" would read as in the future.
		(next) => ({ model: next, commands: [ReadClock()] }),
		(next) => requestStatus(next, context, "aws", "Supersede"),
		(next) =>
			justVerified && (isOpen || !quiet)
				? chain(withCard(next, isOpen ? { setupId: null } : {}), [
						(after) =>
							toast(
								after,
								"success",
								"AWS connected",
								`Maple can read account ${connection.account_id}.`,
							),
					])
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

export const gotCopy = (model: Model, id: string, message: CopyButton.Message): Return => {
	const step = CopyButton.update(model.awsCard.copies[id] ?? CopyButton.init(), message)
	return {
		model: withCard(model, { copies: { ...model.awsCard.copies, [id]: step.model } }),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotAwsCopyMessage({ id, message: inner }),
		),
	}
}

const dialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { disconnectDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotAwsDisconnectDialogMessage({ message }),
	),
})

export const clickedDisconnect = (model: Model, id: AwsConnectionId): Return =>
	dialogStep(withCard(model, { disconnectId: id }), Dialog.open(model.awsCard.disconnectDialog))

export const gotDisconnectDialog = (model: Model, message: Dialog.Message): Return =>
	dialogStep(model, Dialog.update(model.awsCard.disconnectDialog, message))

export const confirmedDisconnect = (model: Model): Return => {
	const id = model.awsCard.disconnectId
	const connection = connectionsOf(model).find((entry) => entry.id === id)
	if (id === null || connection === undefined || model.awsCard.isDisconnecting) return { model }
	return {
		model: withCard(model, { isDisconnecting: true }),
		commands: [DeleteAwsConnection({ id, accountId: connection.account_id })],
	}
}

/**
 * The stack stays in AWS until an administrator deletes it: its cleanup script takes its place.
 * Only this connection's own dialog and setup close: another may have opened meanwhile.
 */
export const completedDisconnect = (
	model: Model,
	context: PageContext,
	id: AwsConnectionId,
	removed: AwsRemovedStack | null,
	error: string | null,
): Return => {
	const settled = withCard(model, { isDisconnecting: false })
	if (removed === null) return toast(settled, "error", "Failed to disconnect AWS", error ?? "")
	const card = settled.awsCard
	const stacks = [removed, ...card.removed.filter((stack) => stack.connectionId !== removed.connectionId)]
	return chain(
		// `disconnectId` stays: the closing dialog still names the account.
		withCard(settled, {
			removed: stacks,
			setupId: card.setupId === id ? null : card.setupId,
			flowId: card.flowId === id ? null : card.flowId,
		}),
		[
			(next) =>
				next.awsCard.disconnectId === id
					? dialogStep(next, Dialog.close(next.awsCard.disconnectDialog))
					: { model: next },
			(next) => ({
				model: next,
				commands: [WriteAwsRemoved({ orgId: context.orgId, removed: stacks })],
			}),
			(next) =>
				toast(next, "success", "AWS disconnected", "Delete the stack in AWS to remove the role."),
			(next) => requestStatus(next, context, "aws", "Supersede"),
		],
	)
}

export const dismissedRemoved = (model: Model, context: PageContext, connectionId: string): Return => {
	const removed = model.awsCard.removed.filter((stack) => stack.connectionId !== connectionId)
	return {
		model: withCard(model, { removed }),
		commands: [WriteAwsRemoved({ orgId: context.orgId, removed })],
	}
}

/** The removed stacks this browser kept for the org, read when the card mounts. */
export const enterAws = (model: Model, context: PageContext): Return => ({
	model,
	commands: [ReadAwsRemoved({ orgId: context.orgId })],
})

export const completedReadRemoved = (model: Model, removed: ReadonlyArray<AwsRemovedStack>): Return => ({
	model: withCard(model, { removed }),
})

const ingestKey = (context: PageContext, id: AwsConnectionId) =>
	requestKey(context.orgId, "awsIntegration.ingest", { id })

/**
 * The ingest of each verified streaming connection, only where the AWS card shows it: a status
 * read loads what is missing, the card's watch refreshes it.
 */
const requestIngest = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	chain(
		model,
		(integrationOfSearch(model.search.integration) === "aws" ? connectionsOf(model) : [])
			.filter((connection) => connection.verified_at !== null && connection.metric_stream !== null)
			.map((connection) => (next: Model) => {
				const slot = next.awsCard.ingest[connection.id] ?? Keyed.idle()
				return Option.match(Keyed.requestFor(slot, ingestKey(context, connection.id), mode), {
					onNone: () => ({ model: next }),
					onSome: (requested) => ({
						model: withCard(next, {
							ingest: { ...next.awsCard.ingest, [connection.id]: requested },
						}),
						commands: [LoadAwsIngest({ key: requested.key, id: connection.id })],
					}),
				})
			}),
	)

/** The status is read again, and with it each stream's ingest; the clock moves "last delivery" along. */
export const tickedWatch = (model: Model, context: PageContext): Return =>
	chain(model, [
		(next) => ({ model: next, commands: [ReadClock()] }),
		(next) => requestStatus(next, context, "aws", "Refresh"),
		(next) => requestIngest(next, context, "Refresh"),
	])

export const completedIngest = (
	model: Model,
	id: AwsConnectionId,
	key: string,
	result: Result.Result<V2AwsIngest, LoadFailure>,
): Return => {
	const slot = model.awsCard.ingest[id]
	if (slot === undefined) return { model }
	return {
		model: withCard(model, {
			ingest: { ...model.awsCard.ingest, [id]: Keyed.accept(slot, key, result) },
		}),
	}
}

/**
 * A status read can verify the open setup before any check of this page does (the hourly check,
 * another tab): the setup closes then too.
 */
export const statusArrived = (
	model: Model,
	context: PageContext,
	before: ReadonlyArray<V2AwsConnection>,
): Return => {
	const setupId = model.awsCard.setupId
	const was = before.find((entry) => entry.id === setupId)
	const now = connectionsOf(model).find((entry) => entry.id === setupId)
	const justVerified = was?.verified_at === null && now !== undefined && now.verified_at !== null
	return chain(model, [
		(next) => requestIngest(next, context, "Load"),
		(next) =>
			justVerified
				? toast(
						withCard(next, { setupId: null }),
						"success",
						"AWS connected",
						`Maple can read account ${now.account_id}.`,
					)
				: { model: next },
	])
}

/** Edit data: the picker opens with what the connection streams. */
export const clickedMetrics = (model: Model, id: AwsConnectionId): Return => ({
	model: withCard(model, { metricsId: id, metricsError: null }),
})

export const cancelledMetrics = (model: Model): Return => ({
	model: withCard(model, { metricsId: null, metricsError: null, selection: null }),
})

/** One region or namespace in or out of what the connection would stream. */
const toggled = (
	model: Model,
	id: AwsConnectionId,
	change: (selection: AwsSelection) => AwsSelection,
): Return => {
	const connection = connectionsOf(model).find((entry) => entry.id === id)
	if (connection === undefined) return { model }
	return {
		model: withCard(model, {
			selection: change(selectionOf(connection, model.awsCard.selection)),
			metricsError: null,
		}),
	}
}

const flip = <A>(values: ReadonlyArray<A>, value: A): ReadonlyArray<A> =>
	values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]

export const toggledRegion = (model: Model, id: AwsConnectionId, region: string): Return =>
	toggled(model, id, (selection) => ({ ...selection, regions: flip(selection.regions, region) }))

export const toggledNamespace = (model: Model, id: AwsConnectionId, namespace: AwsMetricNamespace): Return =>
	toggled(model, id, (selection) => ({ ...selection, namespaces: flip(selection.namespaces, namespace) }))

export const submittedMetrics = (model: Model, id: AwsConnectionId): Return => {
	const card = model.awsCard
	const connection = connectionsOf(model).find((entry) => entry.id === id)
	if (connection === undefined || card.isSavingMetrics) return { model }
	return Option.match(metricStreamOf(selectionOf(connection, card.selection)), {
		onNone: () => ({ model: withCard(model, { metricsError: METRIC_SELECTION_HINT }) }),
		onSome: (metricStream) => ({
			model: withCard(model, { isSavingMetrics: true, metricsError: null }),
			commands: [UpdateAwsMetricStream({ id, metricStream })],
		}),
	})
}

/** AWS only streams once the stack is deployed again, so its setup opens right away. */
export const completedMetricStream = (
	model: Model,
	context: PageContext,
	connection: V2AwsConnection | null,
	error: string | null,
): Return => {
	if (connection === null) {
		return { model: withCard(model, { isSavingMetrics: false, metricsError: error }) }
	}
	return chain(withCard(model, { isSavingMetrics: false, metricsId: null }), [
		// The stored script predates the stream, so it is read again.
		(next) => openSetup(next, context, connection.id, "Supersede"),
		(next) => requestStatus(next, context, "aws", "Supersede"),
		(next) =>
			toast(next, "success", "Metric stream added", "Run the setup again in AWS to start streaming."),
	])
}
