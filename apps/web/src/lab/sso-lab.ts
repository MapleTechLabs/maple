import {
	EnterpriseSsoDocument,
	IsoDateTimeString,
	ScimDirectoryDocument,
	ScimGroupDocument,
	ScimRoleMappingDocument,
	ScimTokenIssued,
	SsoBypassUserDocument,
	SsoConnectionDocument,
	SsoDomainDocument,
	UserId,
} from "@maple/domain/http"
import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as SsoModel from "../page/settings/sso/model"
import * as SsoUpdate from "../page/settings/sso/update"
import * as SsoView from "../page/settings/sso/view"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/sso`: the settings SSO & SCIM tab over fixtures. `?state=` picks one: not-entitled, empty,
// pending (a domain awaiting its TXT record), connected, oidc, sso-only (SCIM add-on not bought),
// configured, token, enforce, member.

export const LabState = Schema.Literals([
	"not-entitled",
	"empty",
	"pending",
	"connected",
	"oidc",
	"sso-only",
	"configured",
	"token",
	"enforce",
	"member",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "configured",
	),
}))

export const Model = Schema.Struct({ sso: SsoModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotSsoMessage: { message: SsoModel.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const iso = Schema.decodeSync(IsoDateTimeString)
const userId = Schema.decodeSync(UserId)

const pendingDomain = new SsoDomainDocument({
	domain: "acmelabs.io",
	status: "pending",
	recordName: "_maple-challenge.acmelabs.io",
	recordValue: "maple-domain-verification=3f9c2a71d04b4e8e9a6b51c07d2e8f14",
	verifiedAt: null,
})
const verifiedDomain = new SsoDomainDocument({
	domain: "acme.com",
	status: "verified",
	recordName: "_maple-challenge.acme.com",
	recordValue: "maple-domain-verification=91b0c4d2e7f84a3b8c5d6e7f9a0b1c2d",
	verifiedAt: iso("2026-11-14T09:12:00.000Z"),
})

const connection = (enforced: boolean) =>
	new SsoConnectionDocument({
		name: "Acme Okta",
		provider: "saml_okta",
		protocol: "saml",
		domains: ["acme.com"],
		enforced,
		acsUrl: "https://clerk.maple.dev/v1/saml/acs/samlc_2xAcmeOkta",
		spEntityId: "https://clerk.maple.dev/saml/samlc_2xAcmeOkta",
		spMetadataUrl: "https://clerk.maple.dev/v1/saml/metadata/samlc_2xAcmeOkta",
		idpMetadataUrl: "https://acme.okta.com/app/exk1a2b3c4/sso/saml/metadata",
		idpSsoUrl: null,
		idpEntityId: null,
		idpCertificateExpiresAt: iso("2029-03-01T00:00:00.000Z"),
		oidcDiscoveryUrl: null,
		oidcClientId: null,
		oidcRedirectUri: null,
		createdAt: iso("2026-11-14T09:20:00.000Z"),
	})

const oidcConnection = new SsoConnectionDocument({
	name: "Acme Identity",
	provider: "oidc_custom",
	protocol: "oidc",
	domains: ["acme.com"],
	enforced: false,
	acsUrl: null,
	spEntityId: null,
	spMetadataUrl: null,
	idpMetadataUrl: null,
	idpSsoUrl: null,
	idpEntityId: null,
	idpCertificateExpiresAt: null,
	oidcDiscoveryUrl: "https://id.acme.com/.well-known/openid-configuration",
	oidcClientId: "maple-dashboard",
	oidcRedirectUri: "https://clerk.maple.dev/v1/oauth_callback",
	createdAt: iso("2026-11-14T09:20:00.000Z"),
})

const directory = new ScimDirectoryDocument({
	endpointUrl: "https://api.clerk.com/scim/v2",
	enabled: true,
	paused: false,
	createdAt: iso("2026-11-14T09:30:00.000Z"),
})

const groups = [
	new ScimGroupDocument({ groupId: "grp_eng", displayName: "Engineering" }),
	new ScimGroupDocument({ groupId: "grp_fin", displayName: "Finance" }),
	new ScimGroupDocument({ groupId: "grp_it", displayName: "IT Admins" }),
	new ScimGroupDocument({ groupId: "grp_sre", displayName: "SRE" }),
]

const bypass = [new SsoBypassUserDocument({ userId: userId("user_ada"), identifier: "ada@acme.com" })]

const documentOf = (state: LabState): EnterpriseSsoDocument => {
	const base = {
		ssoEntitled: true,
		scimEntitled: true,
		domains: [] as Array<SsoDomainDocument>,
		connection: null,
		directory: null,
		roleMappings: [] as Array<ScimRoleMappingDocument>,
		groups: [] as Array<ScimGroupDocument>,
		bypassUsers: [] as Array<SsoBypassUserDocument>,
	}
	switch (state) {
		case "not-entitled":
			return new EnterpriseSsoDocument({ ...base, ssoEntitled: false, scimEntitled: false })
		case "empty":
			return new EnterpriseSsoDocument(base)
		case "pending":
			return new EnterpriseSsoDocument({ ...base, domains: [verifiedDomain, pendingDomain] })
		case "connected":
		case "enforce":
			return new EnterpriseSsoDocument({
				...base,
				domains: [verifiedDomain, pendingDomain],
				connection: connection(false),
				bypassUsers: bypass,
			})
		case "sso-only":
			return new EnterpriseSsoDocument({
				...base,
				scimEntitled: false,
				domains: [verifiedDomain],
				connection: connection(true),
				bypassUsers: bypass,
			})
		case "oidc":
			return new EnterpriseSsoDocument({
				...base,
				domains: [verifiedDomain],
				connection: oidcConnection,
				bypassUsers: bypass,
			})
		// What a reader without `sso:manage` is sent: the state, with no URLs, endpoint, groups,
		// role mappings or bypass list.
		case "member":
			return new EnterpriseSsoDocument({
				...base,
				domains: [verifiedDomain],
				connection: new SsoConnectionDocument({
					...connection(true),
					acsUrl: null,
					spEntityId: null,
					spMetadataUrl: null,
					idpMetadataUrl: null,
					idpCertificateExpiresAt: null,
				}),
				directory: new ScimDirectoryDocument({
					enabled: true,
					paused: false,
					createdAt: iso("2026-11-14T09:30:00.000Z"),
				}),
			})
		case "configured":
		case "token":
			return new EnterpriseSsoDocument({
				...base,
				domains: [verifiedDomain],
				connection: connection(true),
				directory,
				groups,
				bypassUsers: bypass,
				roleMappings: [
					new ScimRoleMappingDocument({
						groupId: "grp_it",
						groupName: "IT Admins",
						role: "org:admin",
					}),
					new ScimRoleMappingDocument({
						groupId: "grp_sre",
						groupName: "SRE",
						role: "org:engineer",
					}),
					new ScimRoleMappingDocument({
						groupId: "grp_eng",
						groupName: "Engineering",
						role: "org:member",
					}),
					new ScimRoleMappingDocument({
						groupId: "grp_fin",
						groupName: "Finance",
						role: "org:analyst",
					}),
				],
			})
	}
}

const MEMBERS: ReadonlyArray<SsoModel.MemberOption> = [
	{ userId: "user_ada", name: "Ada Lovelace", identifier: "ada@acme.com" },
	{ userId: "user_grace", name: "Grace Hopper", identifier: "grace@acme.com" },
	{ userId: "user_linus", name: "Linus Contractor", identifier: "linus@gmail.com" },
]

const step = (model: SsoModel.Model, message: SsoModel.Message): SsoModel.Model =>
	SsoUpdate.update(model, message).model

export const init = (flags: Flags): Return => {
	const document = documentOf(flags.state)
	const loaded = Arr.reduce(
		[
			SsoModel.Message.CompletedFetchDocument({ result: Result.succeed(document) }),
			SsoModel.Message.CompletedFetchMembers({ result: Result.succeed(MEMBERS) }),
		],
		SsoUpdate.init(flags.state !== "member").model,
		step,
	)
	const opening =
		flags.state === "token"
			? SsoModel.Message.CompletedIssueToken({
					action: "rotateToken",
					result: Result.succeed(
						new ScimTokenIssued({
							document,
							token: "scim_live_7Qm2c9VxR4tLpZ8aKfJ3wY6nB1hD5sE0",
						}),
					),
				})
			: flags.state === "enforce"
				? SsoModel.Message.ToggledEnforcement()
				: null
	if (opening === null) return { model: { sso: loaded } }
	// The dialog's open commands run, so it mounts as it would from a click.
	const opened = SsoUpdate.update(loaded, opening)
	return {
		model: { sso: opened.model },
		commands: Command.mapMessages(keepLocal(opened.commands), (message) =>
			Message.GotSsoMessage({ message }),
		),
	}
}

/** Kit commands run; every API read and write is dropped. */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotSsoMessage: ({ message: child }) => {
			const next = SsoUpdate.update(model.sso, child)
			return {
				model: { sso: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (message) =>
					Message.GotSsoMessage({ message }),
				),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "SSO & SCIM" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto w-full max-w-4xl p-6")],
		[
			h.submodel({
				slotId: "lab-sso",
				model: model.sso,
				view: SsoView.view,
				viewInputs: { isKnownMember: true },
				toParentMessage: (message: SsoModel.Message) => Message.GotSsoMessage({ message }),
			}),
		],
	)
