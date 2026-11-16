import { ENTERPRISE_SCIM_ADDON_ID, ENTERPRISE_SSO_ADDON_ID } from "@maple/domain/billing"
import {
	AttachRequest,
	type EnterpriseSsoDocument,
	ScimDirectoryStateRequest,
	ScimRoleMappingsRequest,
	SsoAddDomainRequest,
	SsoBypassRequest,
	SsoConnectionRequest,
	SsoEnforcementRequest,
	SsoMappedRole,
	SsoProvider,
	ssoProtocolOf,
} from "@maple/domain/http"
import { UserId } from "@maple/primitives"
import { Array as Arr, Effect, Option, Result, Schema, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import { failureMessage, type LoadFailure, settleTo } from "@maple/views/data/load-failure"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { clerkTry, currentClerkOrganization } from "../../../platform/clerk"
import { buildCheckoutSuccessUrl } from "../../kit/billing/checkout-return"
import { trackProduct } from "../../../data/analytics"
import { PageOutMessage, type PageReturn } from "../../contract"
import { memberDisplayName } from "../kit/members"
import { normalizeDomain } from "../domains/update"
import { revisitData } from "../kit/revisit"
import {
	type ConnectionDraft,
	type DraftField,
	type MappingDraft,
	type MemberOption,
	Message,
	type Model,
	type WriteAction,
} from "./model"

type Return = PageReturn<Model, Message>

export { normalizeDomain }

/** Clerk's page cap; break-glass picks from the first hundred members. */
const MEMBERS_PAGE_SIZE = 100

export const PROVIDERS = SsoProvider.literals
export const MAPPED_ROLES = SsoMappedRole.literals

// Reads

export const FetchEnterpriseSso = Command.define("FetchEnterpriseSso", {
	messages: [Message.CompletedFetchDocument],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.enterpriseSso.get()).pipe(
		settleTo((result) => Message.CompletedFetchDocument({ result })),
	),
})

/** Past this the picker stops listing; the API still accepts anyone it allows. */
const MAX_MEMBER_PAGES = 50

const toMemberOption = (member: {
	readonly publicUserData?: {
		readonly userId?: string
		readonly identifier: string
		readonly firstName: string | null
		readonly lastName: string | null
	} | null
}): ReadonlyArray<MemberOption> => {
	const user = member.publicUserData
	return user === null || user === undefined || user.userId === undefined
		? []
		: [
				{
					userId: user.userId,
					name: memberDisplayName(user) ?? user.identifier,
					identifier: user.identifier,
				},
			]
}

type MembershipPage = {
	readonly total_count: number
	readonly data: ReadonlyArray<Parameters<typeof toMemberOption>[0]>
}

/** Every member: the first page says how many, the rest load four at a time, capped at 50 pages. */
export const fetchAllMembers = <E>(
	page: (initialPage: number) => Effect.Effect<MembershipPage, E>,
): Effect.Effect<ReadonlyArray<MemberOption>, E> =>
	Effect.gen(function* () {
		const first = yield* page(1)
		const pageCount = Math.min(Math.ceil(first.total_count / MEMBERS_PAGE_SIZE), MAX_MEMBER_PAGES)
		const rest = yield* Effect.forEach(pageCount > 1 ? Arr.range(2, pageCount) : [], page, {
			concurrency: 4,
		})
		return Arr.flatMap([first, ...rest], (result) => Arr.flatMap(result.data, toMemberOption))
	})

const FetchSsoMembers = Command.define("FetchSsoMembers", {
	messages: [Message.CompletedFetchMembers],
	execute: currentClerkOrganization.pipe(
		Effect.flatMap((organization) =>
			fetchAllMembers((initialPage) =>
				clerkTry("Couldn't load members", () =>
					organization.getMemberships({ initialPage, pageSize: MEMBERS_PAGE_SIZE }),
				),
			),
		),
		settleTo((result) => Message.CompletedFetchMembers({ result })),
	),
})

// Writes: each answers with the whole document.

const written =
	(action: WriteAction) =>
	<E, R>(effect: Effect.Effect<EnterpriseSsoDocument, E, R>) =>
		effect.pipe(settleTo((result) => Message.CompletedWrite({ action, result })))

const AddSsoDomain = Command.define("AddSsoDomain", {
	args: { domain: Schema.String },
	messages: [Message.CompletedWrite],
	execute: ({ domain }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.enterpriseSso.addDomain({ payload: new SsoAddDomainRequest({ domain }) }),
		).pipe(written("addDomain")),
})

const ADD_ON_PLANS = { sso: ENTERPRISE_SSO_ADDON_ID, scim: ENTERPRISE_SCIM_ADDON_ID } as const

/** Stripe's checkout returns to this tab; with a card on file the add-on attaches at once. */
const AttachSsoAddOn = Command.define("AttachSsoAddOn", {
	args: { planId: Schema.String },
	messages: [Message.CompletedAttachAddOn],
	execute: ({ planId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const successUrl = yield* Effect.sync(() => buildCheckoutSuccessUrl(window.location.href))
			return yield* client.billing.attach({ payload: new AttachRequest({ planId, successUrl }) })
		}).pipe(settleTo((result) => Message.CompletedAttachAddOn({ result }))),
})

const OpenSsoAddOnCheckout = Command.define("OpenSsoAddOnCheckout", {
	args: { url: Schema.String, planId: Schema.String },
	messages: [Message.CompletedOpenAddOnCheckout],
	execute: ({ url, planId }) =>
		trackProduct("plan_checkout_started", { plan_id: planId }).pipe(
			Effect.andThen(
				Effect.sync(() => {
					window.location.href = url
				}),
			),
			Effect.as(Message.CompletedOpenAddOnCheckout()),
		),
})

const VerifySsoDomain = Command.define("VerifySsoDomain", {
	args: { domain: Schema.String },
	messages: [Message.CompletedWrite],
	execute: ({ domain }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.enterpriseSso.verifyDomain({ params: { domain } }),
		).pipe(written("verifyDomain")),
})

const RemoveSsoDomain = Command.define("RemoveSsoDomain", {
	args: { domain: Schema.String },
	messages: [Message.CompletedWrite],
	execute: ({ domain }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.enterpriseSso.removeDomain({ params: { domain } }),
		).pipe(written("removeDomain")),
})

const SaveSsoConnection = Command.define("SaveSsoConnection", {
	args: { mode: Schema.Literals(["create", "edit"]), request: SsoConnectionRequest },
	messages: [Message.CompletedWrite],
	execute: ({ mode, request }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			mode === "create"
				? client.enterpriseSso.createConnection({ payload: request })
				: client.enterpriseSso.updateConnection({ payload: request }),
		).pipe(written(mode === "create" ? "createConnection" : "updateConnection")),
})

const SetSsoEnforcement = Command.define("SetSsoEnforcement", {
	args: { enforced: Schema.Boolean },
	messages: [Message.CompletedWrite],
	execute: ({ enforced }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.enterpriseSso.setEnforcement({ payload: new SsoEnforcementRequest({ enforced }) }),
		).pipe(written(enforced ? "enforce" : "unenforce")),
})

const DeleteSsoConnection = Command.define("DeleteSsoConnection", {
	messages: [Message.CompletedWrite],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.enterpriseSso.deleteConnection()).pipe(
		written("deleteConnection"),
	),
})

const IssueScimToken = Command.define("IssueScimToken", {
	args: { kind: Schema.Literals(["create", "rotate"]) },
	messages: [Message.CompletedIssueToken],
	execute: ({ kind }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			kind === "create"
				? client.enterpriseSso.createDirectory()
				: client.enterpriseSso.rotateDirectoryToken(),
		).pipe(
			settleTo((result) =>
				Message.CompletedIssueToken({
					action: kind === "create" ? "createDirectory" : "rotateToken",
					result,
				}),
			),
		),
})

const SetScimDirectoryState = Command.define("SetScimDirectoryState", {
	args: { paused: Schema.Boolean },
	messages: [Message.CompletedWrite],
	execute: ({ paused }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.enterpriseSso.setDirectoryState({ payload: new ScimDirectoryStateRequest({ paused }) }),
		).pipe(written(paused ? "pause" : "resume")),
})

const DeleteScimDirectory = Command.define("DeleteScimDirectory", {
	messages: [Message.CompletedWrite],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.enterpriseSso.deleteDirectory()).pipe(
		written("deleteDirectory"),
	),
})

const SetScimRoleMappings = Command.define("SetScimRoleMappings", {
	args: { mappings: Schema.Array(Schema.Struct({ groupId: Schema.String, role: SsoMappedRole })) },
	messages: [Message.CompletedWrite],
	execute: ({ mappings }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.enterpriseSso.setRoleMappings({ payload: new ScimRoleMappingsRequest({ mappings }) }),
		).pipe(written("saveMappings")),
})

const AddSsoBypassUser = Command.define("AddSsoBypassUser", {
	args: { userId: UserId },
	messages: [Message.CompletedWrite],
	execute: ({ userId }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.enterpriseSso.addBypassUser({ payload: new SsoBypassRequest({ userId }) }),
		).pipe(written("addBypass")),
})

const RemoveSsoBypassUser = Command.define("RemoveSsoBypassUser", {
	args: { userId: UserId },
	messages: [Message.CompletedWrite],
	execute: ({ userId }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.enterpriseSso.removeBypassUser({ params: { userId } }),
		).pipe(written("removeBypass")),
})

// Init

export const init = (canManage: boolean): Return => ({
	model: {
		canManage,
		document: AsyncData.Loading(),
		members: canManage ? AsyncData.Loading() : AsyncData.Idle(),
		pending: null,
		copies: {},
		selects: {},
		domainMenus: {},
		addDomainDialog: Dialog.init("sso-domain-add", "dialog"),
		domainField: Field.init(),
		removingDomain: null,
		removeDomainDialog: Dialog.init("sso-domain-remove", "alert-dialog"),
		connectionDialog: Dialog.init("sso-connection", "dialog"),
		draft: null,
		enforceDialog: Dialog.init("sso-enforce", "alert-dialog"),
		removeConnectionDialog: Dialog.init("sso-connection-remove", "alert-dialog"),
		bypassDialog: Dialog.init("sso-bypass-add", "dialog"),
		bypassPick: null,
		removingBypass: null,
		removeBypassDialog: Dialog.init("sso-bypass-remove", "alert-dialog"),
		removeDirectoryDialog: Dialog.init("sso-directory-remove", "alert-dialog"),
		rotateDialog: Dialog.init("sso-token-rotate", "alert-dialog"),
		tokenDialog: Dialog.init("sso-token", "dialog"),
		addOn: null,
		addOnDialog: Dialog.init("sso-add-on", "alert-dialog"),
		isAttachingAddOn: false,
		issuedToken: null,
		mappings: null,
		nextMappingKey: 0,
	},
	commands: [FetchEnterpriseSso(), ...(canManage ? [FetchSsoMembers()] : [])],
})

export const revisit = (model: Model): Return => {
	const document = revisitData(model.document, FetchEnterpriseSso)
	const members = retryMembers(model)
	return {
		model: { ...model, document: document.data, members: members.data },
		commands: [...document.commands, ...members.commands],
	}
}

/** A failed member list is fetched again; one that loaded or is loading is left alone. */
const retryMembers = (model: Model) =>
	model.canManage && AsyncData.isFailure(model.members)
		? { data: AsyncData.Loading(), commands: [FetchSsoMembers()] }
		: { data: model.members, commands: [] }

// Derived

export const documentOf = (model: Model): EnterpriseSsoDocument | null =>
	AsyncData.getOrElse(
		AsyncData.map(model.document, (document): EnterpriseSsoDocument | null => document),
		() => null,
	)

export const verifiedDomains = (document: EnterpriseSsoDocument): ReadonlyArray<string> =>
	Arr.flatMap(document.domains, (domain) => (domain.status === "verified" ? [domain.domain] : []))

/** The rows on screen: the draft while editing, else the saved mappings. */
export const mappingRows = (model: Model): ReadonlyArray<MappingDraft> =>
	model.mappings ??
	Arr.map(documentOf(model)?.roleMappings ?? [], (mapping, index) => ({
		key: `saved-${index}`,
		groupId: mapping.groupId,
		role: mapping.role,
	}))

/** Why the rows can't be saved (a row without a group, or a group twice), or null when they can. */
export const mappingsProblem = (rows: ReadonlyArray<MappingDraft>): string | null =>
	Arr.some(rows, (row) => row.groupId === "")
		? "Pick a group for every row."
		: Arr.dedupe(Arr.map(rows, (row) => row.groupId)).length !== rows.length
			? "Map each group to one role only."
			: null

/** Whether a group the IdP pushed is not mapped yet, so another row can be added. */
export const hasUnmappedGroup = (
	document: EnterpriseSsoDocument,
	rows: ReadonlyArray<MappingDraft>,
): boolean => Arr.some(document.groups, (group) => !Arr.some(rows, (row) => row.groupId === group.groupId))

/** One rule: what disables Save is exactly what the footer explains. */
export const isMappingsValid = (rows: ReadonlyArray<MappingDraft>): boolean => mappingsProblem(rows) === null

const isHttps = (value: string): boolean => Str.startsWith("https://")(Str.trim(value))

const draftValue = (draft: ConnectionDraft, field: DraftField): string =>
	Str.trim(draft.fields[field]?.value ?? "")

/** The request a draft submits, or none while a required field is missing. */
export const requestOf = (draft: ConnectionDraft): Option.Option<SsoConnectionRequest> => {
	const value = (field: DraftField) => draftValue(draft, field)
	const isCreate = draft.mode === "create"
	if (value("name") === "" || draft.domains.length === 0) return Option.none()
	const base = { name: value("name"), provider: draft.provider, domains: draft.domains }
	const decode = Schema.decodeUnknownOption(SsoConnectionRequest)
	if (ssoProtocolOf(draft.provider) === "oidc") {
		if (!isHttps(value("discoveryUrl")) || value("clientId") === "") return Option.none()
		if (isCreate && value("clientSecret") === "") return Option.none()
		return decode({
			...base,
			oidc: {
				discoveryUrl: value("discoveryUrl"),
				clientId: value("clientId"),
				...(value("clientSecret") !== "" && { clientSecret: value("clientSecret") }),
			},
		})
	}
	if (draft.samlMode === "metadata")
		return isHttps(value("metadataUrl"))
			? decode({ ...base, saml: { metadataUrl: value("metadataUrl") } })
			: Option.none()
	if (!isHttps(value("ssoUrl")) || value("entityId") === "") return Option.none()
	if (isCreate && value("certificate") === "") return Option.none()
	return decode({
		...base,
		saml: {
			ssoUrl: value("ssoUrl"),
			entityId: value("entityId"),
			...(value("certificate") !== "" && { certificate: value("certificate") }),
		},
	})
}

/** What keeps a draft from submitting, in words, or null when `requestOf` accepts it. */
export const draftProblem = (draft: ConnectionDraft): string | null => {
	const value = (field: DraftField) => draftValue(draft, field)
	const isCreate = draft.mode === "create"
	if (value("name") === "") return "Give the connection a name."
	if (value("name").length > 120) return "Keep the name to 120 characters."
	if (draft.domains.length === 0) return "Pick at least one verified domain."
	if (draft.domains.length > 20) return "Pick at most 20 domains."
	if (ssoProtocolOf(draft.provider) === "oidc") {
		if (!isHttps(value("discoveryUrl"))) return "The discovery URL must start with https://."
		if (value("clientId") === "") return "Add the client ID."
		if (isCreate && value("clientSecret") === "") return "Add the client secret."
	} else if (draft.samlMode === "metadata") {
		if (!isHttps(value("metadataUrl"))) return "The metadata URL must start with https://."
	} else {
		if (!isHttps(value("ssoUrl"))) return "The SSO URL must start with https://."
		if (value("entityId") === "") return "Add the IdP entity ID."
		if (isCreate && value("certificate") === "") return "Add the IdP signing certificate."
	}
	return Option.isNone(requestOf(draft)) ? "One of the values is too long." : null
}

const fieldsOf = (values: Partial<Record<DraftField, string>>): ConnectionDraft["fields"] => ({
	name: Field.init(values.name ?? ""),
	metadataUrl: Field.init(values.metadataUrl ?? ""),
	ssoUrl: Field.init(values.ssoUrl ?? ""),
	entityId: Field.init(values.entityId ?? ""),
	certificate: Field.init(values.certificate ?? ""),
	discoveryUrl: Field.init(values.discoveryUrl ?? ""),
	clientId: Field.init(values.clientId ?? ""),
	clientSecret: Field.init(values.clientSecret ?? ""),
})

const newDraft = (document: EnterpriseSsoDocument): ConnectionDraft => ({
	mode: "create",
	provider: "saml_okta",
	domains: verifiedDomains(document),
	samlMode: "metadata",
	fields: fieldsOf({}),
})

const editDraft = (connection: NonNullable<EnterpriseSsoDocument["connection"]>): ConnectionDraft => ({
	mode: "edit",
	provider: connection.provider,
	domains: connection.domains,
	samlMode: connection.idpMetadataUrl === null && connection.idpSsoUrl !== null ? "manual" : "metadata",
	fields: fieldsOf({
		name: connection.name,
		metadataUrl: connection.idpMetadataUrl ?? "",
		ssoUrl: connection.idpSsoUrl ?? "",
		entityId: connection.idpEntityId ?? "",
		discoveryUrl: connection.oidcDiscoveryUrl ?? "",
		clientId: connection.oidcClientId ?? "",
	}),
})

// Steps

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

type DialogKey =
	| "addDomainDialog"
	| "removeDomainDialog"
	| "connectionDialog"
	| "enforceDialog"
	| "removeConnectionDialog"
	| "bypassDialog"
	| "removeBypassDialog"
	| "removeDirectoryDialog"
	| "rotateDialog"
	| "tokenDialog"
	| "addOnDialog"

const dialogMessage = (key: DialogKey, message: Dialog.Message): Message => {
	switch (key) {
		case "addDomainDialog":
			return Message.GotAddDomainDialogMessage({ message })
		case "removeDomainDialog":
			return Message.GotRemoveDomainDialogMessage({ message })
		case "connectionDialog":
			return Message.GotConnectionDialogMessage({ message })
		case "enforceDialog":
			return Message.GotEnforceDialogMessage({ message })
		case "removeConnectionDialog":
			return Message.GotRemoveConnectionDialogMessage({ message })
		case "bypassDialog":
			return Message.GotBypassDialogMessage({ message })
		case "removeBypassDialog":
			return Message.GotRemoveBypassDialogMessage({ message })
		case "removeDirectoryDialog":
			return Message.GotRemoveDirectoryDialogMessage({ message })
		case "rotateDialog":
			return Message.GotRotateDialogMessage({ message })
		case "tokenDialog":
			return Message.GotTokenDialogMessage({ message })
		case "addOnDialog":
			return Message.GotAddOnDialogMessage({ message })
	}
}

const dialogStep = (model: Model, key: DialogKey, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, [key]: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => dialogMessage(key, message)),
})

const openDialog = (model: Model, key: DialogKey): Return => dialogStep(model, key, Dialog.open(model[key]))
const closeDialog = (model: Model, key: DialogKey): Return => dialogStep(model, key, Dialog.close(model[key]))

/** A dialog's own messages; it stays put while its write is in flight. */
const updateDialog = (model: Model, key: DialogKey, message: Dialog.Message): Return =>
	model.pending !== null && key !== "tokenDialog"
		? { model }
		: dialogStep(model, key, Dialog.update(model[key], message))

const merge = (first: Return, second: Return): Return => ({
	...second,
	commands: [...(first.commands ?? []), ...(second.commands ?? [])],
})

/** Starts a write unless one is already running, or the viewer only reads. */
type WriteCommand = NonNullable<Return["commands"]>[number]

const startWrite = (model: Model, action: WriteAction, command: WriteCommand): Return =>
	model.pending !== null || !model.canManage
		? { model }
		: { model: { ...model, pending: action }, commands: [command] }

const SUCCESS_TITLES = {
	addDomain: "Domain added. Publish the TXT record, then verify it.",
	verifyDomain: "Domain verified",
	removeDomain: "Domain removed",
	createConnection: "Identity provider connected",
	updateConnection: "Identity provider saved",
	enforce: "SSO is now required",
	unenforce: "SSO is no longer required",
	deleteConnection: "Identity provider removed",
	createDirectory: "SCIM provisioning set up",
	rotateToken: "SCIM token rotated",
	pause: "SCIM provisioning paused",
	resume: "SCIM provisioning resumed",
	deleteDirectory: "SCIM provisioning removed",
	saveMappings: "Role mappings saved",
	addBypass: "Break-glass member added",
	removeBypass: "Break-glass member removed",
} as const satisfies { readonly [A in WriteAction]: string }

/** Names the failed action; the server's message says why. */
const FAILURE_TITLES = {
	addDomain: "Couldn't add the domain",
	verifyDomain: "Couldn't verify the domain",
	removeDomain: "Couldn't remove the domain",
	createConnection: "Couldn't connect the identity provider",
	updateConnection: "Couldn't save the identity provider",
	enforce: "Couldn't require SSO",
	unenforce: "Couldn't stop requiring SSO",
	deleteConnection: "Couldn't remove the identity provider",
	createDirectory: "Couldn't set up SCIM",
	rotateToken: "Couldn't rotate the SCIM token",
	pause: "Couldn't pause SCIM",
	resume: "Couldn't resume SCIM",
	deleteDirectory: "Couldn't remove SCIM",
	saveMappings: "Couldn't save the role mappings",
	addBypass: "Couldn't add the break-glass member",
	removeBypass: "Couldn't remove the break-glass member",
} as const satisfies { readonly [A in WriteAction]: string }

/** The dialog a successful write closes, and the state it clears. */
const afterSuccess = (model: Model, action: WriteAction): Return => {
	switch (action) {
		case "addDomain":
			return closeDialog({ ...model, domainField: Field.init() }, "addDomainDialog")
		case "removeDomain":
			return closeDialog({ ...model, removingDomain: null }, "removeDomainDialog")
		case "createConnection":
		case "updateConnection":
			return closeDialog({ ...model, draft: null, selects: {} }, "connectionDialog")
		case "enforce":
			return closeDialog(model, "enforceDialog")
		case "deleteConnection":
			return closeDialog({ ...model, mappings: null }, "removeConnectionDialog")
		case "rotateToken":
			return closeDialog(model, "rotateDialog")
		case "deleteDirectory":
			return closeDialog({ ...model, mappings: null, selects: {} }, "removeDirectoryDialog")
		case "saveMappings":
			return { model: { ...model, mappings: null, selects: {} } }
		case "addBypass":
			return closeDialog({ ...model, bypassPick: null }, "bypassDialog")
		case "removeBypass":
			return closeDialog({ ...model, removingBypass: null }, "removeBypassDialog")
		case "verifyDomain":
		case "unenforce":
		case "createDirectory":
		case "pause":
		case "resume":
			return { model }
	}
}

const failed = (model: Model, action: WriteAction, failure: LoadFailure): Return => ({
	model: { ...model, pending: null },
	outMessage: toast("error", FAILURE_TITLES[action], failureMessage(failure)),
})

const settled = (model: Model, action: WriteAction, document: EnterpriseSsoDocument): Return => {
	// A pasted URL is saved as its domain: the toast names what was actually added.
	const title =
		action === "addDomain"
			? `Added ${normalizeDomain(model.domainField.value)}. Publish the TXT record, then verify it.`
			: SUCCESS_TITLES[action]
	const step = afterSuccess(
		{ ...model, pending: null, document: AsyncData.Success({ data: document }) },
		action,
	)
	return { ...step, outMessage: toast("success", title) }
}

const fieldStep = (model: Model, child: Field.Message): Return => {
	const step = Field.update(model.domainField, child)
	return {
		model: { ...model, domainField: step.model },
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotDomainFieldMessage({ message: inner }),
		),
	}
}

const selectModel = (model: Model, key: string): Select.Model =>
	model.selects[key] ?? Select.init(`sso-select-${key}`, { value: "", selectedIndex: null })

const withRows = (model: Model, rows: ReadonlyArray<MappingDraft>): Model => ({ ...model, mappings: rows })

/** A picked select value lands where its key says. */
const applyPick = (model: Model, key: string, value: string): Model => {
	const draft = model.draft
	if (key === "provider")
		return draft === null
			? model
			: Option.match(Schema.decodeUnknownOption(SsoProvider)(value), {
					onNone: () => model,
					onSome: (provider) => ({ ...model, draft: { ...draft, provider } }),
				})
	if (key === "bypass") return { ...model, bypassPick: value }
	const rows = mappingRows(model)
	if (Str.startsWith("group-")(key)) {
		const rowKey = Str.slice(6)(key)
		return withRows(
			model,
			Arr.map(rows, (row) => (row.key === rowKey ? { ...row, groupId: value } : row)),
		)
	}
	if (Str.startsWith("role-")(key)) {
		const rowKey = Str.slice(5)(key)
		return Option.match(Schema.decodeUnknownOption(SsoMappedRole)(value), {
			onNone: () => model,
			onSome: (role) =>
				withRows(
					model,
					Arr.map(rows, (row) => (row.key === rowKey ? { ...row, role } : row)),
				),
		})
	}
	return model
}

const moveRow = (rows: ReadonlyArray<MappingDraft>, key: string, by: -1 | 1): ReadonlyArray<MappingDraft> =>
	Option.match(
		Arr.findFirstIndex(rows, (row) => row.key === key),
		{
			onNone: () => rows,
			onSome: (index) => {
				const target = index + by
				const row = rows[index]
				const other = rows[target]
				if (row === undefined || other === undefined) return rows
				return Arr.map(rows, (current, at) => (at === index ? other : at === target ? row : current))
			},
		},
	)

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchDocument: ({ result }) => ({
			model: { ...model, document: AsyncData.settle(model.document, result) },
		}),
		CompletedFetchMembers: ({ result }) => ({
			model: { ...model, members: AsyncData.settle(model.members, result) },
		}),
		ClickedRetry: () => {
			const members = retryMembers(model)
			return {
				model: { ...model, document: AsyncData.Loading(), members: members.data },
				commands: [FetchEnterpriseSso(), ...members.commands],
			}
		},
		CompletedWrite: ({ action, result }) =>
			Result.match(result, {
				onSuccess: (document) => settled(model, action, document),
				onFailure: (failure) => failed(model, action, failure),
			}),
		CompletedIssueToken: ({ action, result }) =>
			Result.match(result, {
				onSuccess: ({ document, token }) => {
					const step = settled(model, action, document)
					const revealed = openDialog(
						{
							...step.model,
							issuedToken: token,
							copies: { ...step.model.copies, token: CopyButton.init() },
						},
						"tokenDialog",
					)
					return { ...merge(step, revealed), outMessage: step.outMessage }
				},
				onFailure: (failure) => failed(model, action, failure),
			}),
		GotCopyMessage: ({ key, message: child }) => {
			const step = CopyButton.update(model.copies[key] ?? CopyButton.init(), child)
			return {
				model: { ...model, copies: { ...model.copies, [key]: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotCopyMessage({ key, message: inner }),
				),
			}
		},
		GotSelectMessage: ({ key, message: child }) => {
			const step = Select.update(selectModel(model, key), child)
			const next = { ...model, selects: { ...model.selects, [key]: step.model } }
			const commands = Command.mapMessages(step.commands ?? [], (inner) =>
				Message.GotSelectMessage({ key, message: inner }),
			)
			return {
				model: step.outMessage === undefined ? next : applyPick(next, key, step.outMessage.value),
				commands,
			}
		},

		// Domains
		ClickedAddDomain: () => (model.canManage ? openDialog(model, "addDomainDialog") : { model }),
		GotAddDomainDialogMessage: ({ message: child }) => updateDialog(model, "addDomainDialog", child),
		GotDomainFieldMessage: ({ message: child }) => fieldStep(model, child),
		SubmittedAddDomain: () => {
			const domain = normalizeDomain(model.domainField.value)
			return domain === "" ? { model } : startWrite(model, "addDomain", AddSsoDomain({ domain }))
		},
		ClickedVerifyDomain: ({ domain }) => startWrite(model, "verifyDomain", VerifySsoDomain({ domain })),
		GotDomainMenuMessage: ({ domain, message: child }) => {
			const menuId = `sso-domain-${domain}`
			const step = Menu.update(model.domainMenus[menuId] ?? Menu.init(menuId), child)
			const next = { ...model, domainMenus: { ...model.domainMenus, [menuId]: step.model } }
			const commands = Command.mapMessages(step.commands ?? [], (inner) =>
				Message.GotDomainMenuMessage({ domain, message: inner }),
			)
			if (step.outMessage?._tag !== "SelectedItem") return { model: next, commands }
			if (step.outMessage.value === "verify")
				return merge(
					{ model: next, commands },
					startWrite(next, "verifyDomain", VerifySsoDomain({ domain })),
				)
			return merge(
				{ model: next, commands },
				openDialog({ ...next, removingDomain: domain }, "removeDomainDialog"),
			)
		},
		GotRemoveDomainDialogMessage: ({ message: child }) =>
			updateDialog(model, "removeDomainDialog", child),
		ClickedConfirmRemoveDomain: () =>
			model.removingDomain === null
				? { model }
				: startWrite(model, "removeDomain", RemoveSsoDomain({ domain: model.removingDomain })),

		// Identity provider
		ClickedConnect: () => {
			const document = documentOf(model)
			return document === null || !model.canManage
				? { model }
				: openDialog({ ...model, draft: newDraft(document), selects: {} }, "connectionDialog")
		},
		ClickedEditConnection: () => {
			const connection = documentOf(model)?.connection ?? null
			return connection === null || !model.canManage
				? { model }
				: openDialog({ ...model, draft: editDraft(connection), selects: {} }, "connectionDialog")
		},
		GotConnectionDialogMessage: ({ message: child }) => {
			const step = updateDialog(model, "connectionDialog", child)
			return step.model.connectionDialog.isOpen
				? step
				: { ...step, model: { ...step.model, draft: null } }
		},
		GotDraftFieldMessage: ({ field, message: child }) => {
			const draft = model.draft
			if (draft === null) return { model }
			const step = Field.update(draft.fields[field] ?? Field.init(), child)
			return {
				model: { ...model, draft: { ...draft, fields: { ...draft.fields, [field]: step.model } } },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotDraftFieldMessage({ field, message: inner }),
				),
			}
		},
		PickedSamlMode: ({ mode }) =>
			model.draft === null
				? { model }
				: { model: { ...model, draft: { ...model.draft, samlMode: mode } } },
		ToggledDraftDomain: ({ domain }) => {
			const draft = model.draft
			if (draft === null) return { model }
			const domains = draft.domains.includes(domain)
				? Arr.filter(draft.domains, (current) => current !== domain)
				: [...draft.domains, domain]
			return { model: { ...model, draft: { ...draft, domains } } }
		},
		SubmittedConnection: () => {
			const draft = model.draft
			if (draft === null) return { model }
			return Option.match(requestOf(draft), {
				onNone: () => ({ model }),
				onSome: (request) =>
					startWrite(
						model,
						draft.mode === "create" ? "createConnection" : "updateConnection",
						SaveSsoConnection({ mode: draft.mode, request }),
					),
			})
		},
		ToggledEnforcement: () => {
			const connection = documentOf(model)?.connection ?? null
			if (connection === null || !model.canManage || model.pending !== null) return { model }
			return connection.enforced
				? startWrite(model, "unenforce", SetSsoEnforcement({ enforced: false }))
				: openDialog(model, "enforceDialog")
		},
		GotEnforceDialogMessage: ({ message: child }) => updateDialog(model, "enforceDialog", child),
		ClickedConfirmEnforce: () => startWrite(model, "enforce", SetSsoEnforcement({ enforced: true })),
		ClickedRemoveConnection: () =>
			model.canManage ? openDialog(model, "removeConnectionDialog") : { model },
		GotRemoveConnectionDialogMessage: ({ message: child }) =>
			updateDialog(model, "removeConnectionDialog", child),
		ClickedConfirmRemoveConnection: () => startWrite(model, "deleteConnection", DeleteSsoConnection()),

		// Break-glass
		ClickedAddBypass: () => {
			if (!model.canManage) return { model }
			const members = retryMembers(model)
			const opened = openDialog({ ...model, bypassPick: null, members: members.data }, "bypassDialog")
			return { ...opened, commands: [...(opened.commands ?? []), ...members.commands] }
		},
		GotBypassDialogMessage: ({ message: child }) => updateDialog(model, "bypassDialog", child),
		SubmittedBypass: () =>
			Option.match(Schema.decodeUnknownOption(UserId)(model.bypassPick), {
				onNone: () => ({ model }),
				onSome: (userId) => startWrite(model, "addBypass", AddSsoBypassUser({ userId })),
			}),
		ClickedRemoveBypass: ({ userId }) =>
			model.canManage
				? openDialog({ ...model, removingBypass: userId }, "removeBypassDialog")
				: { model },
		GotRemoveBypassDialogMessage: ({ message: child }) =>
			updateDialog(model, "removeBypassDialog", child),
		ClickedConfirmRemoveBypass: () =>
			Option.match(Schema.decodeUnknownOption(UserId)(model.removingBypass), {
				onNone: () => ({ model }),
				onSome: (userId) => startWrite(model, "removeBypass", RemoveSsoBypassUser({ userId })),
			}),

		// SCIM
		ClickedSetUpScim: () => startWrite(model, "createDirectory", IssueScimToken({ kind: "create" })),
		ClickedTogglePaused: () => {
			const directory = documentOf(model)?.directory ?? null
			if (directory === null) return { model }
			const paused = !directory.paused
			return startWrite(model, paused ? "pause" : "resume", SetScimDirectoryState({ paused }))
		},
		// Add-ons
		ClickedAddAddOn: ({ addOn }) =>
			!model.canManage || model.isAttachingAddOn
				? { model }
				: openDialog({ ...model, addOn }, "addOnDialog"),
		GotAddOnDialogMessage: ({ message: child }) =>
			model.isAttachingAddOn ? { model } : updateDialog(model, "addOnDialog", child),
		ClickedConfirmAddOn: () =>
			model.isAttachingAddOn || model.addOn === null
				? { model }
				: {
						model: { ...model, isAttachingAddOn: true },
						commands: [AttachSsoAddOn({ planId: ADD_ON_PLANS[model.addOn] })],
					},
		CompletedAttachAddOn: ({ result }) => {
			const planId = model.addOn === null ? "" : ADD_ON_PLANS[model.addOn]
			const closed = dialogStep(
				{ ...model, isAttachingAddOn: false, addOn: null },
				"addOnDialog",
				Dialog.close(model.addOnDialog),
			)
			return Result.match(result, {
				onSuccess: ({ paymentUrl }) =>
					paymentUrl !== undefined && paymentUrl !== null && paymentUrl !== ""
						? {
								...closed,
								commands: [
									...(closed.commands ?? []),
									OpenSsoAddOnCheckout({ url: paymentUrl, planId }),
								],
							}
						: {
								model: { ...closed.model, document: AsyncData.Loading() },
								commands: [...(closed.commands ?? []), FetchEnterpriseSso()],
								// The add-on is on the app's customer too: the root re-reads it.
								outMessage: PageOutMessage.RequestedCustomerRefresh({
									toast: { type: "success", title: "Add-on added", description: "" },
								}),
							},
				onFailure: (error) => ({
					...closed,
					outMessage: toast("error", "Couldn't add the add-on", failureMessage(error)),
				}),
			})
		},
		CompletedOpenAddOnCheckout: () => ({ model }),
		ClickedRotateToken: () => (model.canManage ? openDialog(model, "rotateDialog") : { model }),
		GotRotateDialogMessage: ({ message: child }) => updateDialog(model, "rotateDialog", child),
		ClickedConfirmRotate: () => startWrite(model, "rotateToken", IssueScimToken({ kind: "rotate" })),
		GotTokenDialogMessage: ({ message: child }) => {
			const step = updateDialog(model, "tokenDialog", child)
			if (step.model.tokenDialog.isOpen) return step
			// Closed: the token leaves the model for good.
			const { token: _token, ...copies } = step.model.copies
			return { ...step, model: { ...step.model, issuedToken: null, copies } }
		},
		ClickedRemoveDirectory: () =>
			model.canManage ? openDialog(model, "removeDirectoryDialog") : { model },
		GotRemoveDirectoryDialogMessage: ({ message: child }) =>
			updateDialog(model, "removeDirectoryDialog", child),
		ClickedConfirmRemoveDirectory: () => startWrite(model, "deleteDirectory", DeleteScimDirectory()),
		ClickedAddMapping: () => {
			const rows = mappingRows(model)
			const document = documentOf(model)
			// Every group already has a row: another would only be a duplicate.
			if (document === null || !hasUnmappedGroup(document, rows)) return { model }
			const used = Arr.map(rows, (row) => row.groupId)
			const groupId = Option.match(
				Arr.findFirst(documentOf(model)?.groups ?? [], (group) => !used.includes(group.groupId)),
				{ onNone: () => "", onSome: (group) => group.groupId },
			)
			return {
				model: {
					...withRows(model, [
						...rows,
						{ key: `new-${model.nextMappingKey}`, groupId, role: "org:member" },
					]),
					nextMappingKey: model.nextMappingKey + 1,
				},
			}
		},
		ClickedMoveMapping: ({ key, by }) => ({
			model: withRows(model, moveRow(mappingRows(model), key, by)),
		}),
		ClickedRemoveMapping: ({ key }) => ({
			model: withRows(
				model,
				Arr.filter(mappingRows(model), (row) => row.key !== key),
			),
		}),
		ClickedDiscardMappings: () => ({ model: { ...model, mappings: null, selects: {} } }),
		ClickedSaveMappings: () => {
			const rows = mappingRows(model)
			if (model.mappings === null || !isMappingsValid(rows)) return { model }
			return startWrite(
				model,
				"saveMappings",
				SetScimRoleMappings({
					mappings: Arr.map(rows, (row) => ({ groupId: row.groupId, role: row.role })),
				}),
			)
		},
	})
