import { CreatableApiKeyKind } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { V2ApiKeyCreateParams, V2ApiKeyWithSecret, type V2Scope } from "@maple/domain/http/v2"
import { type ApiKeyCreateOptions, buildApiKeyCreatePayload } from "../kit/api-key-create-payload"
import { Effect, Option, Result, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { trackProduct } from "../../../data/analytics"
import { LoadFailure, settleTo } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Select from "@maple/views/ui/select"

// The create-key dialog, one Submodel shared by the Keys and MCP tabs.

export const EXPIRATION_OPTIONS = [
	{ value: "never", label: "Never" },
	{ value: "7", label: "7 days" },
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
	{ value: "365", label: "1 year" },
] as const

export const SCOPE_FAMILIES = Policy.apiKeyScopeFamilies

export const ScopeLevel = Schema.Literals(["none", "read", "write"])
export type ScopeLevel = typeof ScopeLevel.Type
export const AccessMode = Schema.Literals(["full", "restricted"])
export type AccessMode = typeof AccessMode.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	kind: CreatableApiKeyKind,
	name: Field.Model,
	description: Field.Model,
	expiration: Select.Model,
	accessMode: AccessMode,
	/** The opener's grants: without `api_keys:manage` the key is restricted to scopes they can use. */
	grants: Schema.Array(Policy.PermissionName),
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
	grants: [],
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
	GotExpirationMessage: { message: Select.Message },
	ClickedAccessMode: { mode: AccessMode },
	ClickedAllScopes: { level: ScopeLevel },
	ClickedClearScopes: {},
	ClickedScopeLevel: { family: Schema.String, level: ScopeLevel },
	ChangedScopeFilter: { value: Schema.String },
	ClickedClearScopeFilter: {},
	ClickedCancel: {},
	ClickedCreate: {},
	CompletedCreate: { kind: CreatableApiKeyKind, result: Schema.Result(V2ApiKeyWithSecret, LoadFailure) },
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
	args: { kind: CreatableApiKeyKind, payload: V2ApiKeyCreateParams },
	messages: [Message.CompletedCreate],
	execute: ({ kind, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.apiKeys.create({ payload })
		}).pipe(settleTo((result) => Message.CompletedCreate({ kind, result }))),
})

/** `api_key_created`: the key's kind and access (an MCP key is always full access). */
export const TrackKeyCreated = Command.define("TrackApiKeyCreated", {
	args: { kind: CreatableApiKeyKind, access: Schema.String },
	messages: [Message.CompletedTrackKeyCreated],
	execute: ({ kind, access }) =>
		trackProduct("api_key_created", { kind, access }).pipe(Effect.as(Message.CompletedTrackKeyCreated())),
})

const levelOf = (model: Model, family: string): ScopeLevel => model.scopeLevels[family] ?? "none"

/** Whether the opener may create a full-access key, not only a restricted one. */
export const canGrantFullAccess = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "api_keys:manage")

/** Whether the opener may put `level` on `family`; `none` always. */
export const canGrantLevel = (
	model: Pick<Model, "grants">,
	family: Policy.ApiKeyScopeFamily,
	level: ScopeLevel,
): boolean =>
	level === "none" ||
	canGrantFullAccess(model) ||
	Policy.canGrantFamily((permission) => Policy.has(model.grants, permission), family, level)

/** The most of `level` the opener may put on `family`: write falls back to read, then none. */
const grantableLevel = (model: Model, family: Policy.ApiKeyScopeFamily, level: ScopeLevel): ScopeLevel =>
	Arr.findFirst(level === "write" ? (["write", "read"] as const) : ([level] as const), (candidate) =>
		canGrantLevel(model, family, candidate),
	).pipe(Option.getOrElse((): ScopeLevel => "none"))

export const selectedFamilyCount = (model: Model): number =>
	Arr.filter(SCOPE_FAMILIES, (family) => levelOf(model, family.id) !== "none").length

const scopesOf = (model: Model): ReadonlyArray<V2Scope> =>
	Arr.flatMap(SCOPE_FAMILIES, (family) => {
		const level = levelOf(model, family.id)
		return level === "read" || level === "write" ? [`${family.id}:${level}`] : []
	})

const restrictedScopes = (model: Model): ReadonlyArray<V2Scope> | undefined =>
	model.kind !== "mcp" && model.accessMode === "restricted" ? scopesOf(model) : undefined

const isMissingScopes = (model: Model): boolean => restrictedScopes(model)?.length === 0

export const canCreate = (model: Model): boolean =>
	Str.trim(model.name.value).length > 0 && !isMissingScopes(model) && !model.isCreating

/** A disabled Create says which field is missing. */
export const blockedReason = (model: Model): string | null =>
	Str.trim(model.name.value).length === 0
		? "Name the key so you can tell it apart later."
		: isMissingScopes(model)
			? "Give at least one resource family read or write access."
			: null

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/**
 * The form resets as the dialog closes, but a create in flight stays in flight, so its secret
 * lands in `created` and no second create starts.
 */
const reset = (model: Model): Model => ({
	...init(model.dialog.id),
	kind: model.kind,
	dialog: model.dialog,
	isCreating: model.isCreating,
})

const close = (model: Model): Return => liftDialog(reset(model), Dialog.close(model.dialog))

/**
 * Opens empty for `kind`; a key created while it was closed is shown. Someone who may only create
 * restricted keys starts on Restricted.
 */
export const open = (
	model: Model,
	kind: CreatableApiKeyKind,
	grants: ReadonlyArray<Policy.Permission>,
): Return => {
	const fresh = init(model.dialog.id)
	const kept = { isCreating: model.isCreating, created: model.created }
	const accessMode: AccessMode = Policy.has(grants, "api_keys:manage") ? "full" : "restricted"
	return liftDialog(
		{ ...fresh, ...kept, kind, grants, accessMode, dialog: model.dialog },
		Dialog.open(model.dialog),
	)
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
		GotExpirationMessage: ({ message: child }) => {
			const step = Select.update(model.expiration, child)
			return {
				model: { ...model, expiration: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotExpirationMessage({ message: inner }),
				),
			}
		},
		ClickedAccessMode: ({ mode }) =>
			mode === "full" && !canGrantFullAccess(model)
				? { model }
				: { model: { ...model, accessMode: mode } },
		ClickedAllScopes: ({ level }) => ({
			model: {
				...model,
				scopeLevels: Rec.fromEntries(
					Arr.map(SCOPE_FAMILIES, (family) => [family.id, grantableLevel(model, family, level)]),
				),
			},
		}),
		ClickedClearScopes: () => ({ model: { ...model, scopeLevels: {} } }),
		ClickedScopeLevel: ({ family, level }) =>
			Option.match(
				Arr.findFirst(SCOPE_FAMILIES, (entry) => entry.id === family),
				{
					onNone: () => ({ model }),
					onSome: (entry) =>
						canGrantLevel(model, entry, level)
							? { model: { ...model, scopeLevels: { ...model.scopeLevels, [family]: level } } }
							: { model },
				},
			),
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
