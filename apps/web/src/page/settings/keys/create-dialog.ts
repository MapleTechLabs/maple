import { ApiKeyKind } from "@maple/domain/http"
import { V2ApiKeyCreateParams, V2ApiKeyWithSecret, type V2Scope } from "@maple/domain/http/v2"
import {
	type ApiKeyCreateOptions,
	buildApiKeyCreatePayload,
} from "../../../components/settings/api-key-create-payload"
import { Effect, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { trackProduct } from "../../../data/analytics"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Select from "../../../ui/select"

// `CreateApiKeyDialog`, as one Submodel shared by the Keys and MCP tabs.

export const EXPIRATION_OPTIONS = [
	{ value: "never", label: "Never" },
	{ value: "7", label: "7 days" },
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
	{ value: "365", label: "1 year" },
] as const

export const SCOPE_FAMILIES = [
	{ id: "api_keys", label: "API keys" },
	{ id: "dashboards", label: "Dashboards" },
	{ id: "alerts", label: "Alerts" },
	{ id: "ingest_keys", label: "Ingest keys" },
	{ id: "attribute_mappings", label: "Attribute mappings" },
	{ id: "scrape_targets", label: "Scrape targets" },
	{ id: "instrumentation", label: "Recommendations" },
	{ id: "investigations", label: "Investigations" },
	{ id: "error_issues", label: "Errors" },
	{ id: "anomalies", label: "Anomalies" },
	{ id: "session_replays", label: "Session replays" },
	{ id: "traces", label: "Traces" },
	{ id: "logs", label: "Logs" },
	{ id: "metrics", label: "Metrics" },
	{ id: "services", label: "Services" },
	{ id: "service_map", label: "Service map" },
	{ id: "sources", label: "Sources" },
	{ id: "integrations", label: "Integrations" },
	{ id: "query", label: "Query" },
	{ id: "organization", label: "Organization" },
	{ id: "audit_log", label: "Audit log" },
] as const

export const ScopeLevel = Schema.Literals(["none", "read", "write"])
export type ScopeLevel = typeof ScopeLevel.Type
export const AccessMode = Schema.Literals(["full", "restricted"])
export type AccessMode = typeof AccessMode.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	kind: ApiKeyKind,
	name: Field.Model,
	description: Field.Model,
	expiration: Select.Model,
	accessMode: AccessMode,
	/** Families with a level other than `none`. */
	scopeLevels: Schema.Record(Schema.String, ScopeLevel),
	scopeFilter: Schema.String,
	isCreating: Schema.Boolean,
	created: Schema.NullOr(V2ApiKeyWithSecret),
	secretCopy: CopyButton.Model,
	isSecretVisible: Schema.Boolean,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "dialog"),
	kind: "standard",
	name: Field.init(),
	description: Field.init(),
	expiration: Select.init(`${id}-expiration`, { value: "never", selectedIndex: 0 }),
	accessMode: "full",
	scopeLevels: {},
	scopeFilter: "",
	isCreating: false,
	created: null,
	secretCopy: CopyButton.init(),
	isSecretVisible: false,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotNameMessage: { message: Field.Message },
	GotDescriptionMessage: { message: Field.Message },
	PressedNameKey: { key: Schema.String },
	GotExpirationMessage: { message: Select.Message },
	ClickedAccessMode: { mode: AccessMode },
	ClickedAllScopes: { level: ScopeLevel },
	ClickedClearScopes: {},
	ClickedScopeLevel: { family: Schema.String, level: ScopeLevel },
	ChangedScopeFilter: { value: Schema.String },
	ClickedClearScopeFilter: {},
	ClickedCancel: {},
	ClickedCreate: {},
	CompletedCreate: { kind: ApiKeyKind, result: Schema.Result(V2ApiKeyWithSecret, LoadFailure) },
	GotSecretCopyMessage: { message: CopyButton.Message },
	ToggledSecretVisible: {},
	/** `trackProduct("api_key_created")` was handed to the session SDK. */
	CompletedTrackKeyCreated: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	RequestedToast: {
		type: Schema.Literals(["success", "error"]),
		title: Schema.String,
		description: Schema.String,
	},
	CreatedKey: { secret: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

export const CreateApiKey = Command.define("CreateApiKey", {
	args: { kind: ApiKeyKind, payload: V2ApiKeyCreateParams },
	messages: [Message.CompletedCreate],
	execute: ({ kind, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.apiKeys.create({ payload })
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedCreate({ kind, result })),
		),
})

/** `api_key_created`: the key's kind and access (an MCP key is always full access). */
export const TrackKeyCreated = Command.define("TrackApiKeyCreated", {
	args: { kind: ApiKeyKind, access: Schema.String },
	messages: [Message.CompletedTrackKeyCreated],
	execute: ({ kind, access }) =>
		trackProduct("api_key_created", { kind, access }).pipe(Effect.as(Message.CompletedTrackKeyCreated())),
})

// DERIVED

const levelOf = (model: Model, family: string): ScopeLevel => model.scopeLevels[family] ?? "none"

export const selectedFamilyCount = (model: Model): number =>
	SCOPE_FAMILIES.filter((family) => levelOf(model, family.id) !== "none").length

const scopesOf = (model: Model): ReadonlyArray<V2Scope> =>
	SCOPE_FAMILIES.flatMap((family) => {
		const level = levelOf(model, family.id)
		return level === "read" || level === "write" ? [`${family.id}:${level}`] : []
	})

const restrictedScopes = (model: Model): ReadonlyArray<V2Scope> | undefined =>
	model.kind !== "mcp" && model.accessMode === "restricted" ? scopesOf(model) : undefined

const isMissingScopes = (model: Model): boolean => restrictedScopes(model)?.length === 0

export const canCreate = (model: Model): boolean =>
	model.name.value.trim().length > 0 && !isMissingScopes(model) && !model.isCreating

/** A disabled Create says which field is missing. */
export const blockedReason = (model: Model): string | null =>
	model.name.value.trim().length === 0
		? "Name the key so you can tell it apart later."
		: isMissingScopes(model)
			? "Give at least one resource family read or write access."
			: null

// UPDATE

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/**
 * `handleClose(false)`: the form resets as the dialog closes, but a create in flight stays in
 * flight, so its secret lands in `created` and no second create starts.
 */
const reset = (model: Model): Model => ({
	...init(model.dialog.id),
	kind: model.kind,
	dialog: model.dialog,
	isCreating: model.isCreating,
})

const close = (model: Model): Return => liftDialog(reset(model), Dialog.close(model.dialog))

/** Opens empty for `kind` (`openCreate`); a key created while it was closed is shown. */
export const open = (model: Model, kind: ApiKeyKind): Return => {
	const fresh = init(model.dialog.id)
	const kept = { isCreating: model.isCreating, created: model.created }
	return liftDialog({ ...fresh, ...kept, kind, dialog: model.dialog }, Dialog.open(model.dialog))
}

const create = (model: Model): Return => {
	if (!canCreate(model)) return { model }
	const scopes = restrictedScopes(model)
	const expiration = model.expiration.value
	const expiry: ApiKeyCreateOptions =
		expiration === "never" ? {} : { expiresInSeconds: Number(expiration) * 86_400 }
	const options: ApiKeyCreateOptions = scopes === undefined ? expiry : { ...expiry, scopes }
	const payload = buildApiKeyCreatePayload(model.name.value, model.description.value, model.kind, options)
	return { model: { ...model, isCreating: true }, commands: [CreateApiKey({ kind: model.kind, payload })] }
}

const field = (current: Field.Model, message: Field.Message): Field.Model =>
	Field.update(current, message).model

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) => {
			const step = Dialog.update(model.dialog, child)
			// Every dismissal (Escape, the close button, outside press) resets the form.
			return liftDialog(step.outMessage?._tag === "Closed" ? reset(model) : model, step)
		},
		GotNameMessage: ({ message: child }) => ({ model: { ...model, name: field(model.name, child) } }),
		GotDescriptionMessage: ({ message: child }) => ({
			model: { ...model, description: field(model.description, child) },
		}),
		PressedNameKey: ({ key }) => (key === "Enter" ? create(model) : { model }),
		GotExpirationMessage: ({ message: child }) => {
			const step = Select.update(model.expiration, child)
			return {
				model: { ...model, expiration: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotExpirationMessage({ message: inner }),
				),
			}
		},
		ClickedAccessMode: ({ mode }) => ({ model: { ...model, accessMode: mode } }),
		ClickedAllScopes: ({ level }) => ({
			model: {
				...model,
				scopeLevels: Object.fromEntries(SCOPE_FAMILIES.map((family) => [family.id, level])),
			},
		}),
		ClickedClearScopes: () => ({ model: { ...model, scopeLevels: {} } }),
		ClickedScopeLevel: ({ family, level }) => ({
			model: { ...model, scopeLevels: { ...model.scopeLevels, [family]: level } },
		}),
		ChangedScopeFilter: ({ value }) => ({ model: { ...model, scopeFilter: value } }),
		ClickedClearScopeFilter: () => ({ model: { ...model, scopeFilter: "" } }),
		ClickedCancel: () => close(model),
		ClickedCreate: () => create(model),
		CompletedCreate: ({ kind, result }) =>
			Result.match(result, {
				onSuccess: (created) => ({
					model: { ...model, isCreating: false, created },
					commands: [TrackKeyCreated({ kind, access: kind === "mcp" ? "full" : model.accessMode })],
					outMessage: OutMessage.CreatedKey({ secret: created.secret }),
				}),
				onFailure: (error) => ({
					model: { ...model, isCreating: false },
					outMessage: OutMessage.RequestedToast({
						type: "error",
						title: kind === "mcp" ? "Couldn't create MCP key" : "Couldn't create API key",
						description: error.message,
					}),
				}),
			}),
		GotSecretCopyMessage: ({ message: child }) => {
			const step = CopyButton.update(model.secretCopy, child)
			return {
				model: { ...model, secretCopy: step.model },
				commands: Command.mapMessages(step.commands, (inner) =>
					Message.GotSecretCopyMessage({ message: inner }),
				),
			}
		},
		ToggledSecretVisible: () => ({ model: { ...model, isSecretVisible: !model.isSecretVisible } }),
		CompletedTrackKeyCreated: () => ({ model }),
	})
