import { AttachResult, EnterpriseSsoDocument, ScimTokenIssued } from "@maple/domain/http"
import { Array as Arr, Option, Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Select from "@maple/views/ui/select"
import { type DraftField, Message, type Model } from "./model"
import { draftProblem, init, requestOf, update } from "./update"
import { view as ssoView } from "./view"

const CREATED = "2026-11-16T10:00:00.000Z"

const connection = {
	name: "Okta",
	provider: "saml_okta",
	protocol: "saml",
	domains: ["acme.com"],
	enforced: false,
	acsUrl: "https://clerk.maple.dev/v1/saml/acs/abc",
	spEntityId: "https://clerk.maple.dev/saml/abc",
	spMetadataUrl: "https://clerk.maple.dev/v1/saml/metadata/abc",
	idpMetadataUrl: "https://acme.okta.com/metadata",
	idpSsoUrl: null,
	idpEntityId: null,
	idpCertificateExpiresAt: null,
	oidcDiscoveryUrl: null,
	oidcClientId: null,
	oidcRedirectUri: null,
	createdAt: CREATED,
} as const

const verifiedDomain = {
	domain: "acme.com",
	status: "verified",
	recordName: "_maple-challenge.acme.com",
	recordValue: "maple-verify=abc",
	verifiedAt: CREATED,
} as const

const doc = (overrides: Partial<typeof EnterpriseSsoDocument.Encoded> = {}): EnterpriseSsoDocument =>
	Schema.decodeSync(EnterpriseSsoDocument)({
		ssoEntitled: true,
		scimEntitled: true,
		domains: [],
		connection: null,
		directory: null,
		roleMappings: [],
		groups: [],
		bypassUsers: [],
		...overrides,
	})

const loaded = (document: EnterpriseSsoDocument, canManage = true): Model =>
	update(init(canManage).model, Message.CompletedFetchDocument({ result: Result.succeed(document) })).model

const names = (step: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	Arr.map(step.commands ?? [], (command) => command.name)

const view = withViewInputs(ssoView, { isKnownMember: true })()

const dialogMounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

describe("sso tab", () => {
	test("an org without the add-on sees one notice to buy it, and no setup actions", () => {
		scene(
			{ update, view },
			given(loaded(doc({ ssoEntitled: false, scimEntitled: false }))),
			expectView(text("Single sign-on is a $100/month add-on")).toExist(),
			expectView(role("button", { name: "Add single sign-on" })).toExist(),
			expectView(role("button", { name: "Add domain" })).not.toExist(),
			expectView(text("Identity provider")).not.toExist(),
		)
	})

	test("an entitled admin starts from the empty state, and SCIM waits for a connection", () => {
		scene(
			{ update, view },
			given(loaded(doc({ domains: [verifiedDomain] }))),
			expectView(text("No identity provider")).toExist(),
			expectView(role("button", { name: "Add domain" })).toExist(),
			expectView(role("button", { name: "Connect identity provider" })).toBeEnabled(),
			expectView(text("SCIM provisioning")).not.toExist(),
		)
	})

	test("a pending domain shows the TXT record to publish", () => {
		const pending = {
			...verifiedDomain,
			status: "pending" as const,
			verifiedAt: null,
		}
		const model = loaded(doc({ domains: [pending] }))
		scene(
			{ update, view },
			given(model),
			expectView(text("_maple-challenge.acme.com")).toExist(),
			expectView(text("maple-verify=abc")).toExist(),
		)
		expect(
			update(model, Message.ClickedVerifyDomain({ domain: "acme.com" })).commands?.[0],
		).toMatchObject({
			name: "VerifySsoDomain",
			args: { domain: "acme.com" },
		})
	})

	test("a member reads the settings but cannot change them", () => {
		const model = loaded(doc({ domains: [verifiedDomain], connection }), false)
		scene(
			{ update, view },
			given(model),
			expectView(text("Only admins can change SSO and SCIM settings.")).toExist(),
			expectView(role("button", { name: "Add domain" })).toBeDisabled(),
			expectView(role("button", { name: "Edit" })).toBeDisabled(),
			expectView(
				role("group", { name: "Only org admins can manage single sign-on and SCIM provisioning." }),
			).toExist(),
		)
		expect(names(update(model, Message.ClickedConfirmEnforce()))).toEqual([])
		expect(names(update(model, Message.ClickedSetUpScim()))).toEqual([])
	})

	test("a connected IdP shows what to paste, and requiring SSO asks first", () => {
		const model = loaded(doc({ domains: [verifiedDomain], connection }))
		scene(
			{ update, view },
			given(model),
			expectView(text("https://clerk.maple.dev/v1/saml/acs/abc")).toExist(),
			expectView(role("switch", { name: "Require SSO" })).toExist(),
		)
		const asked = update(model, Message.ToggledEnforcement())
		expect(asked.model.enforceDialog.isOpen).toBe(true)
		expect(names(asked)).not.toContain("SetSsoEnforcement")
		scene(
			{ update, view },
			given(asked.model),
			dialogMounted,
			expectView(text("Require SSO?")).toExist(),
			expectView(text(/Add a break-glass member first/)).toExist(),
		)
		expect(update(asked.model, Message.ClickedConfirmEnforce()).commands?.[0]).toMatchObject({
			name: "SetSsoEnforcement",
			args: { enforced: true },
		})
	})

	test("turning enforcement off needs no confirm", () => {
		const model = loaded(
			doc({ domains: [verifiedDomain], connection: { ...connection, enforced: true } }),
		)
		const step = update(model, Message.ToggledEnforcement())
		expect(step.model.enforceDialog.isOpen).toBe(false)
		expect(step.commands?.[0]).toMatchObject({ name: "SetSsoEnforcement", args: { enforced: false } })
	})

	test("the SCIM token shows once and leaves the model when its dialog closes", () => {
		const model = loaded(doc({ domains: [verifiedDomain], connection }))
		const started = update(model, Message.ClickedSetUpScim())
		expect(started.commands?.[0]).toMatchObject({ name: "IssueScimToken", args: { kind: "create" } })
		const directory = {
			endpointUrl: "https://api.maple.dev/scim/v2/abc",
			enabled: true,
			paused: false,
			createdAt: CREATED,
		}
		const issued = new ScimTokenIssued({
			document: doc({ domains: [verifiedDomain], connection, directory }),
			token: "scim_secret_token",
		})
		const revealed = update(
			started.model,
			Message.CompletedIssueToken({ action: "createDirectory", result: Result.succeed(issued) }),
		).model
		expect(revealed.issuedToken).toBe("scim_secret_token")
		expect(revealed.tokenDialog.isOpen).toBe(true)
		scene(
			{ update, view },
			given(revealed),
			dialogMounted,
			expectView(text(/You will not see this token again/)).toExist(),
			expectView(text("https://api.maple.dev/scim/v2/abc")).toExist(),
		)
		const closed = update(
			revealed,
			Message.GotTokenDialogMessage({ message: Dialog.Message.ClickedClose() }),
		)
		expect(closed.model.tokenDialog.isOpen).toBe(false)
		expect(closed.model.issuedToken).toBeNull()
	})

	test("role mappings save in row order with the picked roles", () => {
		const directory = {
			endpointUrl: "https://api.maple.dev/scim/v2/abc",
			enabled: true,
			paused: false,
			createdAt: CREATED,
		}
		const groups = [
			{ groupId: "grp_eng", displayName: "Engineering" },
			{ groupId: "grp_admins", displayName: "Admins" },
		]
		const start = loaded(doc({ domains: [verifiedDomain], connection, directory, groups }))
		const twoRows = update(
			update(start, Message.ClickedAddMapping()).model,
			Message.ClickedAddMapping(),
		).model
		expect(Arr.map(twoRows.mappings ?? [], (row) => row.groupId)).toEqual(["grp_eng", "grp_admins"])
		const adminRole = update(
			twoRows,
			Message.GotSelectMessage({
				key: "role-new-1",
				message: Select.Message.SelectedItem({ index: 0, value: "org:admin" }),
			}),
		).model
		const reordered = update(adminRole, Message.ClickedMoveMapping({ key: "new-1", by: -1 })).model
		const saving = update(reordered, Message.ClickedSaveMappings())
		expect(saving.commands?.[0]).toMatchObject({
			name: "SetScimRoleMappings",
			args: {
				mappings: [
					{ groupId: "grp_admins", role: "org:admin" },
					{ groupId: "grp_eng", role: "org:member" },
				],
			},
		})
	})

	test("without pushed groups the mapping section explains where they come from", () => {
		const directory = {
			endpointUrl: "https://api.maple.dev/scim/v2/abc",
			enabled: true,
			paused: true,
			createdAt: CREATED,
		}
		scene(
			{ update, view },
			given(loaded(doc({ domains: [verifiedDomain], connection, directory }))),
			expectView(
				text("Groups appear here after your identity provider pushes them over SCIM."),
			).toExist(),
			expectView(role("button", { name: "Resume" })).toExist(),
		)
	})

	test("a SAML draft needs a metadata URL, or the manual fields and a certificate on create", () => {
		const opened = update(loaded(doc({ domains: [verifiedDomain] })), Message.ClickedConnect()).model
		const typed = (model: Model, values: ReadonlyArray<readonly [DraftField, string]>): Model =>
			Arr.reduce(
				values,
				model,
				(current, [field, value]) =>
					update(
						current,
						Message.GotDraftFieldMessage({
							field,
							message: Field.Message.ChangedValue({ value }),
						}),
					).model,
			)
		const named = typed(opened, [["name", "Okta"]])
		expect(Option.flatMap(Option.fromNullishOr(named.draft), requestOf)._tag).toBe("None")
		const withMetadata = typed(named, [["metadataUrl", "https://acme.okta.com/metadata"]])
		expect(Option.flatMap(Option.fromNullishOr(withMetadata.draft), requestOf)).toMatchObject({
			_tag: "Some",
			value: { domains: ["acme.com"], saml: { metadataUrl: "https://acme.okta.com/metadata" } },
		})
		const manual = typed(update(named, Message.PickedSamlMode({ mode: "manual" })).model, [
			["ssoUrl", "https://acme.okta.com/sso"],
			["entityId", "acme"],
		])
		expect(Option.flatMap(Option.fromNullishOr(manual.draft), requestOf)._tag).toBe("None")
		// A disabled submit names what is missing.
		expect(Option.map(Option.fromNullishOr(manual.draft), draftProblem)).toEqual(
			Option.some("Add the IdP signing certificate."),
		)
		const signed = typed(manual, [["certificate", "CERT"]])
		expect(Option.map(Option.fromNullishOr(signed.draft), draftProblem)).toEqual(Option.some(null))
		expect(names(update(signed, Message.SubmittedConnection()))).toEqual(["SaveSsoConnection"])
	})

	test("an org that left Enterprise can still relax SSO, pause or remove SCIM, and replace its credentials", () => {
		const model = loaded(
			doc({
				ssoEntitled: false,
				scimEntitled: false,
				domains: [verifiedDomain],
				connection: { ...connection, enforced: true },
				directory: {
					endpointUrl: "https://api.clerk.com/scim/v2",
					enabled: true,
					paused: false,
					createdAt: CREATED,
				},
			}),
		)
		scene(
			{ update, view },
			given(model),
			expectView(role("switch", { name: "Require SSO" })).toBeEnabled(),
			expectView(role("button", { name: "Pause" })).toExist(),
			expectView(role("button", { name: "Edit" })).toBeEnabled(),
			expectView(role("button", { name: "Rotate token" })).toBeEnabled(),
			// Setting things up still needs the add-on.
			expectView(role("button", { name: "Add domain" })).not.toExist(),
			expectView(role("button", { name: "Add member" })).not.toExist(),
		)
		const editing = update(model, Message.ClickedEditConnection()).model
		scene(
			{ update, view },
			given(editing),
			dialogMounted,
			expectView(
				text(/you can replace the certificate, the IdP metadata or the client secret/),
			).toExist(),
		)
		expect(update(model, Message.ClickedConfirmRotate()).commands?.[0]).toMatchObject({
			name: "IssueScimToken",
			args: { kind: "rotate" },
		})
	})

	test("a member sees the state the API sends them: no endpoint, groups or break-glass list", () => {
		const model = loaded(
			doc({
				domains: [verifiedDomain],
				connection: {
					...connection,
					enforced: true,
					acsUrl: null,
					spEntityId: null,
					spMetadataUrl: null,
					idpMetadataUrl: null,
				},
				directory: { enabled: true, paused: false, createdAt: CREATED },
			}),
			false,
		)
		scene(
			{ update, view },
			given(model),
			expectView(text("Required")).toExist(),
			expectView(text("SCIM 2.0")).toExist(),
			expectView(text("Active")).toExist(),
			expectView(text("Endpoint URL")).not.toExist(),
			expectView(text("ACS URL")).not.toExist(),
			expectView(text("Break-glass access")).not.toExist(),
			expectView(text("Role mapping")).not.toExist(),
			expectView(role("button", { name: "Rotate token" })).toBeDisabled(),
		)
	})

	test("a failed member list loads again when the break-glass dialog reopens", () => {
		const failed = update(
			loaded(doc({ domains: [verifiedDomain], connection })),
			Message.CompletedFetchMembers({ result: Result.fail(toLoadFailure(new Error("Clerk down"))) }),
		).model
		expect(names(update(failed, Message.ClickedAddBypass()))).toContain("FetchSsoMembers")
	})

	test("an unconfirmed role never claims the viewer is not an admin", () => {
		scene(
			{ update, view: withViewInputs(ssoView, { isKnownMember: false })() },
			given(loaded(doc({ domains: [verifiedDomain], connection }), false)),
			expectView(text("Only admins can change SSO and SCIM settings.")).not.toExist(),
			expectView(role("button", { name: "Edit" })).toBeDisabled(),
		)
	})

	test("an OIDC connection shows the redirect URI to allow in the IdP", () => {
		const oidc = {
			...connection,
			provider: "oidc_custom" as const,
			protocol: "oidc" as const,
			acsUrl: null,
			spEntityId: null,
			spMetadataUrl: null,
			idpMetadataUrl: null,
			oidcDiscoveryUrl: "https://id.acme.com/.well-known/openid-configuration",
			oidcClientId: "maple",
			oidcRedirectUri: "https://clerk.maple.dev/v1/oauth_callback",
		}
		scene(
			{ update, view },
			given(loaded(doc({ domains: [verifiedDomain], connection: oidc }))),
			expectView(text("Redirect URI")).toExist(),
			expectView(text("https://clerk.maple.dev/v1/oauth_callback")).toExist(),
			expectView(text("ACS URL")).not.toExist(),
		)
	})

	test("an org that left Enterprise can still open a domain's menu to remove it", () => {
		scene(
			{ update, view },
			given(loaded(doc({ ssoEntitled: false, scimEntitled: false, domains: [verifiedDomain] }))),
			expectView(role("button", { name: "Actions for acme.com" })).toExist(),
			expectView(role("button", { name: "Add domain" })).not.toExist(),
		)
	})

	test("an admin buys the SSO add-on through a confirm, which attaches the enterprise_sso plan", () => {
		const model = loaded(doc({ ssoEntitled: false, scimEntitled: false }))
		const opened = update(model, Message.ClickedAddAddOn({ addOn: "sso" })).model
		expect(opened.addOn).toBe("sso")
		const confirmed = update(opened, Message.ClickedConfirmAddOn())
		expect(confirmed.commands?.[0]).toMatchObject({
			name: "AttachSsoAddOn",
			args: { planId: "enterprise_sso" },
		})
		// A member cannot start a purchase.
		expect(
			names(
				update(
					loaded(doc({ ssoEntitled: false, scimEntitled: false }), false),
					Message.ClickedAddAddOn({ addOn: "sso" }),
				),
			),
		).toEqual([])
	})

	test("SCIM is its own add-on: with SSO bought, the SCIM section offers it and checkout follows", () => {
		const model = loaded(doc({ scimEntitled: false, domains: [verifiedDomain], connection }))
		scene(
			{ update, view },
			given(model),
			expectView(role("button", { name: "Add SCIM provisioning" })).toExist(),
			expectView(role("button", { name: "Set up SCIM" })).not.toExist(),
		)
		const opened = update(model, Message.ClickedAddAddOn({ addOn: "scim" })).model
		const confirmed = update(opened, Message.ClickedConfirmAddOn())
		expect(confirmed.commands?.[0]).toMatchObject({
			name: "AttachSsoAddOn",
			args: { planId: "enterprise_scim" },
		})
		const checkout = update(
			confirmed.model,
			Message.CompletedAttachAddOn({
				result: Result.succeed(new AttachResult({ paymentUrl: "https://checkout.stripe.test/c" })),
			}),
		)
		expect(names(checkout)).toContain("OpenSsoAddOnCheckout")
	})

	test("toasts name what happened: the domain a pasted URL saved as, and the action that failed", () => {
		const typed = { ...loaded(doc()), domainField: Field.init("https://Acme.com/login") }
		const added = update(
			typed,
			Message.CompletedWrite({
				action: "addDomain",
				result: Result.succeed(doc({ domains: [verifiedDomain] })),
			}),
		)
		expect(added.outMessage).toMatchObject({
			title: "Added acme.com. Publish the TXT record, then verify it.",
		})
		const refused = update(
			loaded(doc()),
			Message.CompletedWrite({
				action: "verifyDomain",
				result: Result.fail(toLoadFailure(new Error("No matching TXT record"))),
			}),
		)
		expect(refused.outMessage).toMatchObject({ title: "Couldn't verify the domain" })
	})

	test("mapping rows explain a disabled Save and stop at one row per group", () => {
		const directory = {
			endpointUrl: "https://api.maple.dev/scim/v2/abc",
			enabled: true,
			paused: false,
			createdAt: CREATED,
		}
		const groups = [
			{ groupId: "grp_eng", displayName: "Engineering" },
			{ groupId: "grp_admins", displayName: "Admins" },
		]
		const start = loaded(doc({ domains: [verifiedDomain], connection, directory, groups }))
		const both = update(
			update(start, Message.ClickedAddMapping()).model,
			Message.ClickedAddMapping(),
		).model
		// Every group has a row: a third Add mapping does nothing, and the button says so.
		expect(update(both, Message.ClickedAddMapping()).model.mappings?.length).toBe(2)
		scene(
			{ update, view },
			given(both),
			expectView(role("button", { name: "Add mapping" })).toBeDisabled(),
		)
		// Pointing both rows at one group disables Save, with the reason beside it.
		const duplicate = update(
			both,
			Message.GotSelectMessage({
				key: "group-new-1",
				message: Select.Message.SelectedItem({ index: 0, value: "grp_eng" }),
			}),
		).model
		scene(
			{ update, view },
			given(duplicate),
			expectView(text("Map each group to one role only.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})
})
