import {
	V2AwsConnection,
	V2AwsCreateConnectionRequest,
	type V2AwsIntegration,
	V2AwsSetup,
} from "@maple/domain/http/v2"
import { AwsConnectionId } from "@maple/domain/primitives"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { displayError, isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { Effect, Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"
import * as CopyButton from "../../ui/copy-button"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import { AwsRemovedStack, AwsSetupMethod } from "./aws-schema"
import { Message } from "./message"

// `AwsIntegrationCard`: state and writes.

export { AwsRemovedStack, AwsSetupMethod } from "./aws-schema"

export const AwsCardModel = Schema.Struct({
	accountId: Field.Model,
	isCreating: Schema.Boolean,
	createError: Schema.NullOr(Schema.String),
	/** The add form while connections exist; with none it always shows. */
	isAdding: Schema.Boolean,
	/** The connection whose setup is open, and its setup read. */
	setupId: Schema.NullOr(AwsConnectionId),
	setup: KeyedSchema(V2AwsSetup, LoadFailure),
	method: AwsSetupMethod,
	/** Checks in flight, by connection; a quiet one raises no toast unless the user asks meanwhile. */
	checking: Schema.Array(Schema.Struct({ id: AwsConnectionId, quiet: Schema.Boolean })),
	copies: Schema.Record(Schema.String, CopyButton.Model),
	disconnectId: Schema.NullOr(AwsConnectionId),
	disconnectDialog: Dialog.Model,
	isDisconnecting: Schema.Boolean,
	removed: Schema.Array(AwsRemovedStack),
})
export type AwsCardModel = typeof AwsCardModel.Type

export const initAwsCard = (): AwsCardModel => ({
	accountId: Field.init(),
	isCreating: false,
	createError: null,
	isAdding: false,
	setupId: null,
	setup: { key: null, data: AsyncData.Idle() },
	method: "cloudshell",
	checking: [],
	copies: {},
	disconnectId: null,
	disconnectDialog: Dialog.init("aws-disconnect", "alert-dialog"),
	isDisconnecting: false,
	removed: [],
})

export const decodeCreateRequest = Schema.decodeUnknownOption(V2AwsCreateConnectionRequest)

/** Account ids are often pasted with the console's dashes: `1234-5678-9012`. */
export const normalizeAccountId = (value: string) => value.replaceAll(/[\s-]/gu, "")

/** Connections whose stack Maple has not assumed yet: the card shows their setup and keeps checking. */
export const pendingConnections = (status: V2AwsIntegration): ReadonlyArray<V2AwsConnection> =>
	status.connections.filter((connection) => connection.verified_at === null)

const messageOf = (error: unknown, fallback: string) => {
	const presentation = displayError(error)
	return isUnexpectedError(presentation) ? fallback : presentation.message
}

export const CreateAwsConnection = Command.define("CreateAwsConnection", {
	args: { request: V2AwsCreateConnectionRequest },
	messages: [Message.SucceededAwsCreate, Message.FailedAwsCreate],
	execute: ({ request }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const connection = yield* client.awsIntegration.createConnection({ payload: request })
			return Message.SucceededAwsCreate({ connection })
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.FailedAwsCreate({ error: messageOf(error, "Failed to connect AWS.") }),
				),
			),
		),
})

export const LoadAwsSetup = Command.define("LoadAwsSetup", {
	args: { key: Schema.String, id: AwsConnectionId },
	messages: [Message.CompletedLoadAwsSetup],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.awsIntegration.setup({ params: { id } })
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedLoadAwsSetup({ key, result })),
		),
})

/** `quiet`: the background re-check while a setup is open, which raises no toast. */
export const CheckAwsConnection = Command.define("CheckAwsConnection", {
	args: { id: AwsConnectionId, quiet: Schema.Boolean },
	messages: [Message.CompletedAwsCheck],
	execute: ({ id, quiet }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.awsIntegration.checkConnection({ params: { id } })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedAwsCheck({ id, quiet, connection: null, failure: toLoadFailure(error) }),
				onSuccess: (connection) =>
					Message.CompletedAwsCheck({ id, quiet, connection, failure: null }),
			}),
		),
})

export const DeleteAwsConnection = Command.define("DeleteAwsConnection", {
	args: { id: AwsConnectionId, accountId: Schema.String },
	messages: [Message.CompletedAwsDisconnect],
	execute: ({ id, accountId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.awsIntegration.deleteConnection({ params: { id } })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedAwsDisconnect({
						id,
						removed: null,
						error: messageOf(error, "Failed to disconnect AWS."),
					}),
				onSuccess: (response) =>
					Message.CompletedAwsDisconnect({
						id,
						removed: { connectionId: id, accountId, cleanupScript: response.cleanup_script },
						error: null,
					}),
			}),
		),
})

// The org's removed stacks survive a reload: the role exists until someone runs the cleanup.
const storageKey = (orgId: string) => `maple.aws.removed-stacks.${orgId}`
const decodeRemoved = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(AwsRemovedStack)))
const encodeRemoved = Schema.encodeSync(Schema.fromJsonString(Schema.Array(AwsRemovedStack)))

export const ReadAwsRemoved = Command.define("ReadAwsRemovedStacks", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedReadAwsRemoved],
	execute: ({ orgId }) =>
		Effect.sync(() =>
			Message.CompletedReadAwsRemoved({
				removed: Option.getOrElse(
					Option.flatMap(readLocalStorage(storageKey(orgId)), decodeRemoved),
					() => [],
				),
			}),
		),
})

export const WriteAwsRemoved = Command.define("WriteAwsRemovedStacks", {
	args: { orgId: Schema.String, removed: Schema.Array(AwsRemovedStack) },
	messages: [Message.CompletedWriteAwsRemoved],
	execute: ({ orgId, removed }) =>
		Effect.sync(() => {
			// Best effort: private mode and blocked site data throw here.
			writeLocalStorage(storageKey(orgId), encodeRemoved(removed))
			return Message.CompletedWriteAwsRemoved()
		}),
})
