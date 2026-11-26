import { customerHasFlag, ENTERPRISE_SCIM_FEATURE_ID, ENTERPRISE_SSO_FEATURE_ID } from "@maple/domain/billing"
import {
	EnterpriseSsoConflictError,
	EnterpriseSsoDocument,
	EnterpriseSsoDomainProofError,
	EnterpriseSsoInvalidError,
	EnterpriseSsoNotEntitledError,
	EnterpriseSsoNotFoundError,
	EnterpriseSsoUnavailableError,
	IsoDateTimeString,
	ScimDirectoryDocument,
	ScimGroupDocument,
	ScimRoleMappingDocument,
	ScimTokenIssued,
	SSO_CHALLENGE_RECORD_PREFIX,
	SsoBypassUserDocument,
	SsoConnectionDocument,
	SsoDomainDocument,
	SsoDomainName,
	SsoMappedRole,
	SsoProvider,
	ssoProtocolOf,
	type OrgId,
	type SsoConnectionRequest,
	UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	OrgDirectoryGroups,
	OrgSsoConnections,
	OrgSsoDomains,
	type OrgSsoConnectionRow,
	type OrgSsoDomainRow,
} from "@maple/db/tables"
import { EdgeCacheService } from "@maple/cache"
import {
	Array as Arr,
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Order,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Hex from "effect/encoding/Hex"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import type { ClerkRequestError } from "@maple/auth"
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import { ensureOk, readCustomerCached } from "@maple/backend/services/billing/autumn-client"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import {
	ClerkSsoGateway,
	type ClerkSsoConnection,
	type ClerkSsoConnectionInput,
	type ClerkSsoDirectory,
} from "./ClerkSsoGateway"
import { DnsTxtResolver } from "@maple/backend/platform/DnsTxtResolver"

type Entitlement = "entitled" | "not_entitled" | "unknown"
/** Which add-on a write needs. */
type AddOn = "sso" | "scim"
interface Entitlements {
	readonly sso: Entitlement
	readonly scim: Entitlement
}

const ADD_ON_FEATURES = { sso: ENTERPRISE_SSO_FEATURE_ID, scim: ENTERPRISE_SCIM_FEATURE_ID } as const
const ADD_ON_REFUSALS = {
	sso: "Single sign-on is a $100/month add-on. Add it under Settings, SSO & SCIM.",
	scim: "SCIM provisioning is a $100/month add-on. Add it under Settings, SSO & SCIM.",
} as const

export type SsoWriteError =
	| EnterpriseSsoUnavailableError
	| EnterpriseSsoNotEntitledError
	| EnterpriseSsoInvalidError
	| EnterpriseSsoConflictError
	| EnterpriseSsoDomainProofError
	| EnterpriseSsoNotFoundError

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)
const iso = (ms: number) => decodeIso(new Date(ms).toISOString())
const isDomainName = Schema.is(SsoDomainName)
const isMappedRole = Schema.is(SsoMappedRole)
const isProvider = Schema.is(SsoProvider)
const decodeUserId = Schema.decodeSync(UserId)
const byDomain = Order.mapInput(Str.Order, (d: SsoDomainDocument) => d.domain)
const byGroupName = Order.mapInput(Str.Order, (g: ScimGroupDocument) => g.displayName)

/** A Clerk object deleted out from under Maple reads as missing, not as an outage. */
const orMissing = <A>(effect: Effect.Effect<A, ClerkRequestError>) =>
	effect.pipe(
		Effect.asSome,
		Effect.catchIf(
			(e) => e.status === 404,
			() => Effect.succeed(Option.none<A>()),
		),
	)
const orEmpty = <A>(effect: Effect.Effect<ReadonlyArray<A>, ClerkRequestError>) =>
	effect.pipe(
		Effect.catchIf(
			(e) => e.status === 404,
			() => Effect.succeed<ReadonlyArray<A>>([]),
		),
	)

/** Best-effort undo of a Clerk object Maple failed to record; a failure is logged, never raised. */
const undo = (what: string, effect: Effect.Effect<void, ClerkRequestError>) =>
	effect.pipe(
		Effect.tapError((error) =>
			Effect.logError(`Could not undo the Clerk ${what} Maple failed to record`).pipe(
				Effect.annotateLogs({ error: error.message }),
			),
		),
		Effect.ignore,
	)

const toPersistenceError = makePersistenceErrorMapper(
	EnterpriseSsoUnavailableError,
	"SSO settings persistence failure",
)

/** Lower-cased, trimmed, no trailing dot, so `Acme.com.` and `acme.com` are one domain. */
export const normalizeDomain = (raw: string): string => Str.replace(/\.$/, "")(Str.toLowerCase(Str.trim(raw)))

export const challengeRecordName = (domain: string) => `${SSO_CHALLENGE_RECORD_PREFIX}.${domain}`

/** Clerk's typed failure as what the settings page can act on; Clerk's 4xx text is user-facing. */
const fromClerk = (error: ClerkRequestError): SsoWriteError => {
	switch (error.status) {
		case 400:
		case 422:
			return new EnterpriseSsoInvalidError({ message: error.message })
		case 409:
			return new EnterpriseSsoConflictError({ message: error.message })
		case 404:
			return new EnterpriseSsoNotFoundError({ message: error.message })
		default:
			return new EnterpriseSsoUnavailableError({ message: `Clerk: ${error.message}` })
	}
}

const unavailable = (error: ClerkRequestError) =>
	new EnterpriseSsoUnavailableError({ message: `Clerk: ${error.message}` })

/** Okta and Entra get Clerk's guided SCIM flavour; everything else pushes as a custom SCIM 2.0 client. */
const directoryProviderFor = (provider: string): "okta" | "entra" | "custom" =>
	provider === "saml_okta" ? "okta" : provider === "saml_microsoft" ? "entra" : "custom"

/**
 * True when an edit changes nothing but the SAML certificate or IdP metadata, or the OIDC client
 * secret: the one edit an organization can still make after its add-on ended.
 */
const replacesCredentialsOnly = (current: ClerkSsoConnection, request: SsoConnectionRequest): boolean => {
	const domains = Arr.dedupe(Arr.map(request.domains, normalizeDomain))
	const sameDomains =
		domains.length === current.domains.length &&
		Arr.every(domains, (d) => Arr.contains(current.domains, d))
	if (Str.trim(request.name) !== current.name || !sameDomains) return false
	const { saml, oidc } = request
	const samlKept =
		saml === undefined ||
		((saml.ssoUrl === undefined || saml.ssoUrl === current.saml?.idpSsoUrl) &&
			(saml.entityId === undefined || saml.entityId === current.saml?.idpEntityId))
	const oidcKept =
		oidc === undefined ||
		(oidc.discoveryUrl === current.oidc?.discoveryUrl && oidc.clientId === current.oidc?.clientId)
	return samlKept && oidcKept
}

export interface DirectoryGroupEvent {
	readonly directoryId: string
	readonly groupId: string
	readonly displayName: string
	readonly updatedAt: number
	readonly deleted: boolean
}

export interface EnterpriseSsoServiceApi {
	readonly get: (orgId: OrgId) => Effect.Effect<EnterpriseSsoDocument, EnterpriseSsoUnavailableError>
	/**
	 * The state a reader without `sso:manage` may see: the domains, whether an IdP is connected and
	 * required, and whether SCIM runs. No IdP or service provider values, endpoint, groups or people.
	 */
	readonly getSummary: (orgId: OrgId) => Effect.Effect<EnterpriseSsoDocument, EnterpriseSsoUnavailableError>
	readonly addDomain: (
		orgId: OrgId,
		userId: UserId,
		domain: string,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly verifyDomain: (
		orgId: OrgId,
		domain: string,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly removeDomain: (
		orgId: OrgId,
		domain: string,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly createConnection: (
		orgId: OrgId,
		userId: UserId,
		request: SsoConnectionRequest,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly updateConnection: (
		orgId: OrgId,
		request: SsoConnectionRequest,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly setEnforcement: (
		orgId: OrgId,
		enforced: boolean,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly deleteConnection: (orgId: OrgId) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	/**
	 * Deletes the Clerk connection and SCIM directory of an organization that is being deleted, so
	 * nothing keeps claiming its domains. Nothing configured is success; a Clerk failure is raised.
	 */
	readonly removeForDeletedOrganization: (orgId: OrgId) => Effect.Effect<void, SsoWriteError>
	readonly createDirectory: (orgId: OrgId) => Effect.Effect<ScimTokenIssued, SsoWriteError>
	readonly rotateDirectoryToken: (orgId: OrgId) => Effect.Effect<ScimTokenIssued, SsoWriteError>
	readonly setDirectoryState: (
		orgId: OrgId,
		paused: boolean,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly deleteDirectory: (orgId: OrgId) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly setRoleMappings: (
		orgId: OrgId,
		mappings: ReadonlyArray<{ readonly groupId: string; readonly role: SsoMappedRole }>,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly addBypassUser: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	readonly removeBypassUser: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<EnterpriseSsoDocument, SsoWriteError>
	/**
	 * Takes someone who left the organization off its bypass list. Not listed is success, and an
	 * entry another organization's connection also serves stays, as in `removeBypassUser`.
	 */
	readonly removeFormerMemberBypass: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<"removed" | "not_listed" | "kept", EnterpriseSsoUnavailableError>
	/**
	 * Applies a `directoryGroup.*` webhook. `not_here` when no org in this region owns the directory:
	 * each region receives every event and only the home region holds the row.
	 */
	readonly applyDirectoryGroup: (
		event: DirectoryGroupEvent,
	) => Effect.Effect<"applied" | "not_here", EnterpriseSsoUnavailableError>
	/**
	 * Whether Clerk still holds the user deprovisioned, asked before a `deprovisioned` webhook
	 * sweeps: deliveries are unordered, so an old one must not revoke keys made after reactivation.
	 * Fails closed: an unanswered lookup or a deleted user reads as deprovisioned.
	 */
	readonly confirmDeprovisioned: (userId: UserId) => Effect.Effect<boolean>
}

export class EnterpriseSsoService extends Context.Service<EnterpriseSsoService, EnterpriseSsoServiceApi>()(
	"@maple/backend/services/org/enterprise-sso/EnterpriseSsoService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const edgeCache = yield* EdgeCacheService
			const autumn = yield* AutumnClient
			const billingCustomers = yield* BillingCustomerResolver
			const clerk = yield* ClerkSsoGateway
			const dns = yield* DnsTxtResolver
			const dbExecute = makeDbExecute(database, "EnterpriseSsoService", toPersistenceError)

			// Billing that is not configured (self-hosted, local dev) sells nothing: everything is on.
			// One customer read answers both add-ons.
			const entitlements = (orgId: OrgId): Effect.Effect<Entitlements> => {
				const all = (state: Entitlement): Entitlements => ({ sso: state, scim: state })
				return billingCustomers.customerFor(orgId).pipe(
					Effect.flatMap((customerId) => readCustomerCached(edgeCache, autumn, customerId)),
					Effect.flatMap(({ result }) => ensureOk(result)),
					Effect.map((customer): Entitlements => ({
						sso: customerHasFlag(customer, ADD_ON_FEATURES.sso) ? "entitled" : "not_entitled",
						scim: customerHasFlag(customer, ADD_ON_FEATURES.scim) ? "entitled" : "not_entitled",
					})),
					Effect.catchTags({
						"@maple/http/errors/BillingNotConfiguredError": () => Effect.succeed(all("entitled")),
						"@maple/http/errors/BillingUpstreamError": (error) =>
							Effect.logWarning("Could not read the SSO add-on entitlements").pipe(
								Effect.annotateLogs({ orgId, error: error.message }),
								Effect.as(all("unknown")),
							),
						"@maple/http/errors/BillingAccountPersistenceError": (error) =>
							Effect.logWarning("Could not read the SSO add-on entitlements").pipe(
								Effect.annotateLogs({ orgId, error: error.message }),
								Effect.as(all("unknown")),
							),
					}),
				)
			}

			const requireClerk = clerk.available
				? Effect.void
				: Effect.fail(
						new EnterpriseSsoInvalidError({
							message:
								"Single sign-on needs Maple's hosted sign-in; this deployment runs without it.",
						}),
					)

			/** Every set-up write starts here: Clerk mode, and the org holds the add-on the write needs. */
			const requireEntitled = Effect.fn("EnterpriseSsoService.requireEntitled")(function* (
				orgId: OrgId,
				addOn: AddOn,
			) {
				yield* Effect.annotateCurrentSpan({ "maple.sso.add_on": addOn })
				yield* requireClerk
				const state = (yield* entitlements(orgId))[addOn]
				if (state === "not_entitled") {
					return yield* new EnterpriseSsoNotEntitledError({ message: ADD_ON_REFUSALS[addOn] })
				}
				if (state === "unknown") {
					return yield* new EnterpriseSsoUnavailableError({
						message: "Could not confirm the add-on with billing.",
					})
				}
			})

			const loadDomains = (orgId: OrgId) =>
				dbExecute((db) =>
					db.run(
						PG.from(OrgSsoDomains)
							.select()
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)

			const loadConnectionRow = (orgId: OrgId) =>
				dbExecute((db) =>
					db.run(
						PG.from(OrgSsoConnections)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])))

			const requireConnectionRow = (orgId: OrgId) =>
				loadConnectionRow(orgId).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () =>
								Effect.fail(
									new EnterpriseSsoNotFoundError({
										message: "Connect an identity provider first.",
									}),
								),
							onSome: Effect.succeed,
						}),
					),
				)

			const requireDirectoryId = (row: OrgSsoConnectionRow) =>
				row.clerkDirectoryId === null
					? Effect.fail(
							new EnterpriseSsoNotFoundError({ message: "Set up SCIM provisioning first." }),
						)
					: Effect.succeed(row.clerkDirectoryId)

			const toDomainDocument = (row: OrgSsoDomainRow) =>
				new SsoDomainDocument({
					domain: row.domain,
					status: row.status,
					recordName: challengeRecordName(row.domain),
					recordValue: row.challenge,
					verifiedAt: row.verifiedAt === null ? null : iso(row.verifiedAt),
				})

			const toConnectionDocument = (c: ClerkSsoConnection) => {
				const provider = isProvider(c.provider) ? c.provider : "saml_custom"
				return new SsoConnectionDocument({
					name: c.name,
					provider,
					protocol: ssoProtocolOf(provider),
					domains: c.domains,
					enforced: c.active,
					acsUrl: c.saml?.acsUrl ?? null,
					spEntityId: c.saml?.spEntityId ?? null,
					spMetadataUrl: c.saml?.spMetadataUrl ?? null,
					idpMetadataUrl: c.saml?.idpMetadataUrl ?? null,
					idpSsoUrl: c.saml?.idpSsoUrl ?? null,
					idpEntityId: c.saml?.idpEntityId ?? null,
					idpCertificateExpiresAt:
						c.saml?.certificateExpiresAt === null || c.saml?.certificateExpiresAt === undefined
							? null
							: iso(c.saml.certificateExpiresAt),
					oidcDiscoveryUrl: c.oidc?.discoveryUrl ?? null,
					oidcClientId: c.oidc?.clientId ?? null,
					oidcRedirectUri: c.oidc?.redirectUri ?? null,
					createdAt: iso(c.createdAt),
				})
			}

			/** The connection's state alone: its name, domains and whether it is required. */
			const toConnectionSummary = (c: ClerkSsoConnection) =>
				new SsoConnectionDocument({
					...toConnectionDocument(c),
					acsUrl: null,
					spEntityId: null,
					spMetadataUrl: null,
					idpMetadataUrl: null,
					idpSsoUrl: null,
					idpEntityId: null,
					idpCertificateExpiresAt: null,
					oidcDiscoveryUrl: null,
					oidcClientId: null,
					oidcRedirectUri: null,
				})

			const toDirectoryDocument = (d: ClerkSsoDirectory) =>
				new ScimDirectoryDocument({
					endpointUrl: d.endpoint_url,
					enabled: d.enabled,
					paused: d.paused,
					createdAt: iso(d.created_at),
				})

			const toDirectorySummary = (d: ClerkSsoDirectory) =>
				new ScimDirectoryDocument({
					enabled: d.enabled,
					paused: d.paused,
					createdAt: iso(d.created_at),
				})

			// A summary never asks Clerk or the database for mappings, groups or the bypass list.
			const read = Effect.fn("EnterpriseSsoService.read")(function* (
				orgId: OrgId,
				scope: "full" | "summary",
			) {
				const full = scope === "full"
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.read_scope": scope })
				const [domains, row, entitled] = yield* Effect.all(
					[loadDomains(orgId), loadConnectionRow(orgId), entitlements(orgId)],
					{ concurrency: "unbounded" },
				)
				const empty = {
					connection: null,
					directory: null,
					roleMappings: [],
					groups: [],
					bypassUsers: [],
				}
				const clerkSide = Option.isNone(row)
					? Effect.succeed(empty)
					: Effect.gen(function* () {
							const { clerkConnectionId, clerkDirectoryId } = row.value
							const [connection, directory, mappings, bypass, groups] = yield* Effect.all(
								[
									orMissing(clerk.getConnection(clerkConnectionId)),
									clerkDirectoryId === null
										? Effect.succeed(Option.none<ClerkSsoDirectory>())
										: orMissing(clerk.getDirectory(clerkDirectoryId)),
									clerkDirectoryId === null || !full
										? Effect.succeed([])
										: clerk.listRoleMappings(clerkDirectoryId).pipe(orEmpty),
									full
										? clerk.listBypassUsers(clerkConnectionId).pipe(orEmpty)
										: Effect.succeed([]),
									clerkDirectoryId === null || !full
										? Effect.succeed([])
										: dbExecute((db) =>
												db.run(
													PG.from(OrgDirectoryGroups)
														.select()
														.where(($) => [
															$.orgId.eq(orgId),
															$.directoryId.eq(clerkDirectoryId),
															$.deletedAt.isNull(),
														]),
												),
											),
								],
								{ concurrency: "unbounded" },
							).pipe(
								Effect.catchTag("@maple/auth/ClerkRequestError", (e) =>
									Effect.fail(unavailable(e)),
								),
							)
							// Removed in Clerk's dashboard or a half-finished delete: show it as not set up.
							if (Option.isNone(connection)) return empty
							const names = new Map(Arr.map(groups, (g) => [g.groupId, g.displayName] as const))
							return {
								connection: full
									? toConnectionDocument(connection.value)
									: toConnectionSummary(connection.value),
								directory: Option.match(directory, {
									onNone: () => null,
									onSome: full ? toDirectoryDocument : toDirectorySummary,
								}),
								roleMappings: Arr.flatMap(mappings, (m) =>
									isMappedRole(m.roleKey)
										? [
												new ScimRoleMappingDocument({
													groupId: m.groupId,
													groupName: m.groupName ?? names.get(m.groupId) ?? null,
													role: m.roleKey,
												}),
											]
										: [],
								),
								groups: Arr.sort(
									Arr.map(
										groups,
										(g) =>
											new ScimGroupDocument({
												groupId: g.groupId,
												displayName: g.displayName,
											}),
									),
									byGroupName,
								),
								bypassUsers: Arr.map(
									bypass,
									(u) =>
										new SsoBypassUserDocument({
											userId: decodeUserId(u.userId),
											identifier: u.identifier,
										}),
								),
							}
						})
				const side = yield* clerkSide
				return new EnterpriseSsoDocument({
					// An outage reads as entitled: the page should not flash an upsell at a paying org.
					ssoEntitled: entitled.sso !== "not_entitled",
					scimEntitled: entitled.scim !== "not_entitled",
					domains: Arr.sort(Arr.map(domains, toDomainDocument), byDomain),
					...side,
				})
			})

			const get = (orgId: OrgId) => read(orgId, "full")
			const getSummary = (orgId: OrgId) => read(orgId, "summary")

			const addDomain = Effect.fn("EnterpriseSsoService.addDomain")(function* (
				orgId: OrgId,
				userId: UserId,
				raw: string,
			) {
				yield* requireEntitled(orgId, "sso")
				const domain = normalizeDomain(raw)
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.domain": domain })
				if (!isDomainName(domain)) {
					return yield* new EnterpriseSsoInvalidError({
						message: `"${raw}" is not a domain name, e.g. acme.com.`,
					})
				}
				const now = yield* Clock.currentTimeMillis
				const bytes = yield* Effect.sync(() => SecureRandom.randomBytesUnsafe(16))
				const challenge = `maple-domain-verification=${Hex.encode(bytes)}`
				const inserted = yield* dbExecute((db) =>
					db.run(
						PG.insertInto(OrgSsoDomains)
							.values({
								orgId,
								domain,
								challenge,
								status: "pending",
								clerkDomainId: null,
								verifiedAt: null,
								createdAt: now,
								createdBy: userId,
							})
							.onConflictDoNothing()
							.returning("domain"),
					),
				)
				// Re-adding keeps the existing challenge; it is not a change, so it is refused, not audited.
				if (inserted.length === 0) {
					return yield* new EnterpriseSsoConflictError({ message: `${domain} is already added.` })
				}
				return yield* get(orgId)
			})

			const requireDomainRow = (orgId: OrgId, domain: string) =>
				loadDomains(orgId).pipe(
					Effect.flatMap((rows) => {
						const row = Option.getOrUndefined(Arr.findFirst(rows, (r) => r.domain === domain))
						return row === undefined
							? Effect.fail(
									new EnterpriseSsoNotFoundError({
										message: `${domain} is not one of this organization's SSO domains.`,
									}),
								)
							: Effect.succeed(row)
					}),
				)

			const verifyDomain = Effect.fn("EnterpriseSsoService.verifyDomain")(function* (
				orgId: OrgId,
				raw: string,
			) {
				yield* requireEntitled(orgId, "sso")
				const domain = normalizeDomain(raw)
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.domain": domain })
				const row = yield* requireDomainRow(orgId, domain)
				if (row.status === "verified") return yield* get(orgId)
				const values = yield* dns.lookupTxt(challengeRecordName(domain)).pipe(
					Effect.mapError(
						(error) =>
							new EnterpriseSsoUnavailableError({
								message: `DNS lookup failed: ${error.message}`,
							}),
					),
				)
				yield* Effect.annotateCurrentSpan({ "maple.sso.txt_records": values.length })
				if (!values.includes(row.challenge)) {
					return yield* new EnterpriseSsoInvalidError({
						message: `No matching TXT record at ${challengeRecordName(domain)} yet. DNS changes can take a few minutes to appear.`,
					})
				}
				const clerkDomainId = yield* clerk
					.ensureOrgDomain(orgId, domain)
					.pipe(Effect.mapError(fromClerk))
				yield* clerk.verifyOrgDomainOwnership(orgId, clerkDomainId).pipe(Effect.mapError(fromClerk))
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.run(
						PG.update(OrgSsoDomains)
							.set({ status: "verified", clerkDomainId, verifiedAt: now })
							// The row whose challenge was checked: one removed and re-added meanwhile stays pending.
							.where(($) => [
								$.orgId.eq(orgId),
								$.domain.eq(domain),
								$.challenge.eq(row.challenge),
							]),
					),
				)
				return yield* get(orgId)
			})

			const removeDomain = Effect.fn("EnterpriseSsoService.removeDomain")(function* (
				orgId: OrgId,
				raw: string,
			) {
				const domain = normalizeDomain(raw)
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.domain": domain })
				yield* requireDomainRow(orgId, domain)
				const row = yield* loadConnectionRow(orgId)
				if (Option.isSome(row)) {
					const connection = yield* orMissing(
						clerk.getConnection(row.value.clerkConnectionId),
					).pipe(Effect.mapError(fromClerk))
					// A connection already gone in Clerk holds no domain.
					if (Option.isSome(connection) && Arr.contains(connection.value.domains, domain)) {
						return yield* new EnterpriseSsoConflictError({
							message: `${domain} is used by the identity provider connection. Remove it there first.`,
						})
					}
				}
				yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(OrgSsoDomains).where(($) => [$.orgId.eq(orgId), $.domain.eq(domain)]),
					),
				)
				return yield* get(orgId)
			})

			/**
			 * Reads each domain's ownership record again. A domain proven once can change hands, so the
			 * proof is checked whenever a connection starts to route the domain's sign-ins.
			 */
			const requireDomainProof = Effect.fn("EnterpriseSsoService.requireDomainProof")(function* (
				orgId: OrgId,
				domains: ReadonlyArray<string>,
			) {
				yield* Effect.annotateCurrentSpan({ "maple.sso.domains_rechecked": domains.length })
				if (domains.length === 0) return
				const rows = yield* loadDomains(orgId)
				yield* Effect.forEach(
					Arr.dedupe(Arr.map(domains, normalizeDomain)),
					(domain): Effect.Effect<void, SsoWriteError> => {
						const row = Arr.findFirst(rows, (r) => r.domain === domain && r.status === "verified")
						if (Option.isNone(row)) {
							return Effect.fail(
								new EnterpriseSsoInvalidError({
									message: `Verify ${domain} before using it for SSO.`,
								}),
							)
						}
						const recordName = challengeRecordName(domain)
						const recordValue = row.value.challenge
						return dns.lookupTxt(recordName).pipe(
							// Fails closed: an unanswered lookup is not a proof.
							Effect.mapError(
								(error) =>
									new EnterpriseSsoUnavailableError({
										message: `Could not check the DNS record for ${domain}. Try again in a few seconds.`,
										cause: error.message,
									}),
							),
							Effect.flatMap((values) =>
								values.includes(recordValue)
									? Effect.void
									: Effect.fail(
											new EnterpriseSsoDomainProofError({
												message: `The DNS record that proves ${domain} is yours is no longer published. Add a TXT record named ${recordName} with the value ${recordValue}, then try again.`,
												domain,
												recordName,
												recordValue,
											}),
										),
							),
						)
					},
					{ concurrency: 5, discard: true },
				)
			})

			/** The request's domains, all verified by this org, and the IdP settings its protocol needs. */
			const connectionInput = Effect.fn("EnterpriseSsoService.connectionInput")(function* (
				orgId: OrgId,
				request: SsoConnectionRequest,
				provider: SsoProvider,
				mode: "create" | "update",
			) {
				const domains = Arr.dedupe(Arr.map(request.domains, normalizeDomain))
				const rows = yield* loadDomains(orgId)
				const verified = new Set(
					Arr.map(
						Arr.filter(rows, (d) => d.status === "verified"),
						(d) => d.domain,
					),
				)
				const unverified = Arr.filter(domains, (d) => !verified.has(d))
				if (unverified.length > 0) {
					return yield* new EnterpriseSsoInvalidError({
						message: `Verify ${Arr.join(unverified, ", ")} before using it for SSO.`,
					})
				}
				const base = { name: Str.trim(request.name), domains }
				if (ssoProtocolOf(provider) === "saml") {
					const saml = request.saml
					// On an edit an omitted certificate keeps the one Clerk holds; a new connection needs it.
					const manual =
						saml?.ssoUrl !== undefined &&
						saml.entityId !== undefined &&
						(saml.certificate !== undefined || mode === "update")
					if (saml === undefined || (saml.metadataUrl === undefined && !manual)) {
						if (mode === "update" && saml === undefined)
							return base satisfies ClerkSsoConnectionInput
						return yield* new EnterpriseSsoInvalidError({
							message:
								"Give the IdP metadata URL, or its SSO URL, entity ID and signing certificate.",
						})
					}
					return { ...base, saml } satisfies ClerkSsoConnectionInput
				} else {
					const oidc = request.oidc
					if (oidc === undefined) {
						if (mode === "update") return base satisfies ClerkSsoConnectionInput
						return yield* new EnterpriseSsoInvalidError({
							message: "Give the OIDC discovery URL, client ID and client secret.",
						})
					}
					if (mode === "create" && (oidc.clientSecret === undefined || oidc.clientSecret === "")) {
						return yield* new EnterpriseSsoInvalidError({
							message: "Give the OIDC client secret.",
						})
					}
					return { ...base, oidc } satisfies ClerkSsoConnectionInput
				}
			})

			const createConnection = Effect.fn("EnterpriseSsoService.createConnection")(function* (
				orgId: OrgId,
				userId: UserId,
				request: SsoConnectionRequest,
			) {
				yield* requireEntitled(orgId, "sso")
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.provider": request.provider })
				const existing = yield* reconcileRow(orgId)
				if (Option.isSome(existing)) {
					return yield* new EnterpriseSsoConflictError({
						message: "This organization already has an identity provider connected.",
					})
				}
				const input = yield* connectionInput(orgId, request, request.provider, "create")
				yield* requireDomainProof(orgId, input.domains)
				// Uninterruptible so a dropped request cannot strand a Clerk connection Maple never saved:
				// one Maple cannot find again would claim the domains forever.
				yield* Effect.uninterruptible(
					Effect.gen(function* () {
						const connection = yield* clerk
							.createConnection(orgId, request.provider, input)
							.pipe(Effect.mapError(fromClerk))
						const now = yield* Clock.currentTimeMillis
						yield* dbExecute((db) =>
							db.run(
								PG.insertInto(OrgSsoConnections).values({
									orgId,
									clerkConnectionId: connection.id,
									clerkDirectoryId: null,
									createdAt: now,
									createdBy: userId,
									updatedAt: now,
								}),
							),
						).pipe(
							Effect.onError(() => undo("connection", clerk.deleteConnection(connection.id))),
						)
					}),
				)
				return yield* get(orgId)
			})

			const updateConnection = Effect.fn("EnterpriseSsoService.updateConnection")(function* (
				orgId: OrgId,
				request: SsoConnectionRequest,
			) {
				yield* requireClerk
				const row = yield* requireConnectionRow(orgId)
				const current = yield* clerk
					.getConnection(row.clerkConnectionId)
					.pipe(Effect.mapError(fromClerk))
				// Replacing a compromised certificate or client secret stays open after the add-on ends.
				const credentialsOnly = replacesCredentialsOnly(current, request)
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.credentials_only": credentialsOnly })
				if (!credentialsOnly) yield* requireEntitled(orgId, "sso")
				const provider = isProvider(current.provider) ? current.provider : request.provider
				const input = yield* connectionInput(orgId, request, provider, "update")
				// A domain the connection did not route before starts to matter here.
				yield* requireDomainProof(
					orgId,
					Arr.filter(input.domains, (d) => !Arr.contains(current.domains, d)),
				)
				yield* clerk.updateConnection(row.clerkConnectionId, input).pipe(Effect.mapError(fromClerk))
				yield* touch(orgId)
				return yield* get(orgId)
			})

			const touch = (orgId: OrgId, set: { clerkDirectoryId?: string | null } = {}) =>
				Clock.currentTimeMillis.pipe(
					Effect.flatMap((now) =>
						dbExecute((db) =>
							db.run(
								PG.update(OrgSsoConnections)
									.set({ updatedAt: now, ...set })
									.where(($) => [$.orgId.eq(orgId)]),
							),
						),
					),
				)

			const setEnforcement = Effect.fn("EnterpriseSsoService.setEnforcement")(function* (
				orgId: OrgId,
				enforced: boolean,
			) {
				// Relaxing is always allowed: an org that lost the plan must still be able to get out.
				if (enforced) yield* requireEntitled(orgId, "sso")
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.enforced": enforced })
				const row = yield* requireConnectionRow(orgId)
				if (enforced) {
					const connection = yield* clerk
						.getConnection(row.clerkConnectionId)
						.pipe(Effect.mapError(fromClerk))
					yield* requireDomainProof(orgId, connection.domains)
				}
				yield* clerk
					.updateConnection(row.clerkConnectionId, { active: enforced })
					.pipe(Effect.mapError(fromClerk))
				yield* touch(orgId)
				return yield* get(orgId)
			})

			const clearDirectory = (orgId: OrgId, directoryId: string) =>
				Clock.currentTimeMillis.pipe(
					Effect.flatMap((now) =>
						dbExecute((db) =>
							db.run(
								PG.update(OrgSsoConnections)
									.set({ clerkDirectoryId: null, updatedAt: now })
									.where(($) => [$.orgId.eq(orgId), $.clerkDirectoryId.eq(directoryId)]),
							),
						),
					),
				)

			/**
			 * The org's row with ids Clerk has confirmed deleted (404) cleared, so a connection or
			 * directory removed in Clerk's dashboard does not block setting up a new one.
			 */
			const reconcileRow = Effect.fn("EnterpriseSsoService.reconcileRow")(function* (orgId: OrgId) {
				const row = yield* loadConnectionRow(orgId)
				if (Option.isNone(row)) return Option.none<OrgSsoConnectionRow>()
				const { clerkConnectionId, clerkDirectoryId } = row.value
				const [connection, directory] = yield* Effect.all(
					[
						orMissing(clerk.getConnection(clerkConnectionId)),
						clerkDirectoryId === null
							? Effect.succeedSome(null)
							: orMissing(clerk.getDirectory(clerkDirectoryId)),
					],
					{ concurrency: "unbounded" },
				).pipe(Effect.mapError(fromClerk))
				const dropGroups = (directoryId: string) =>
					dbExecute((db) =>
						db.run(
							PG.deleteFrom(OrgDirectoryGroups).where(($) => [
								$.orgId.eq(orgId),
								$.directoryId.eq(directoryId),
							]),
						),
					)
				if (Option.isNone(connection)) {
					yield* Effect.annotateCurrentSpan({ "maple.sso.reconciled": "connection" })
					yield* dbExecute((db) =>
						db.run(
							PG.deleteFrom(OrgSsoConnections).where(($) => [
								$.orgId.eq(orgId),
								$.clerkConnectionId.eq(clerkConnectionId),
							]),
						),
					)
					if (clerkDirectoryId !== null) yield* dropGroups(clerkDirectoryId)
					return Option.none<OrgSsoConnectionRow>()
				}
				if (clerkDirectoryId !== null && Option.isNone(directory)) {
					yield* Effect.annotateCurrentSpan({ "maple.sso.reconciled": "directory" })
					yield* clearDirectory(orgId, clerkDirectoryId)
					yield* dropGroups(clerkDirectoryId)
					return Option.some({ ...row.value, clerkDirectoryId: null })
				}
				return row
			})

			/** Clerk first, then the row and groups, so the row never points at a deleted directory. */
			const dropDirectory = (orgId: OrgId, directoryId: string) =>
				clerk.deleteDirectory(directoryId).pipe(
					Effect.catchIf(
						(e) => e.status === 404,
						() => Effect.void,
					),
					Effect.mapError(fromClerk),
					// Only this directory's binding: a slower, overlapping delete must not clear a newer one.
					Effect.andThen(clearDirectory(orgId, directoryId)),
					Effect.andThen(
						dbExecute((db) =>
							db.run(
								PG.deleteFrom(OrgDirectoryGroups).where(($) => [
									$.orgId.eq(orgId),
									$.directoryId.eq(directoryId),
								]),
							),
						),
					),
				)

			/** The directory, then the connection, then the row; each step tolerates one already gone. */
			const dropConnection = Effect.fn("EnterpriseSsoService.dropConnection")(function* (
				orgId: OrgId,
				row: OrgSsoConnectionRow,
			) {
				// Clerk removes the connection's bypass entries itself when the connection is deleted.
				if (row.clerkDirectoryId !== null) yield* dropDirectory(orgId, row.clerkDirectoryId)
				yield* clerk.deleteConnection(row.clerkConnectionId).pipe(
					Effect.catchIf(
						(e) => e.status === 404,
						() => Effect.void,
					),
					Effect.mapError(fromClerk),
				)
				yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(OrgSsoConnections).where(($) => [
							$.orgId.eq(orgId),
							$.clerkConnectionId.eq(row.clerkConnectionId),
						]),
					),
				)
			})

			const deleteConnection = Effect.fn("EnterpriseSsoService.deleteConnection")(function* (
				orgId: OrgId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const row = yield* requireConnectionRow(orgId)
				yield* dropConnection(orgId, row)
				return yield* get(orgId)
			})

			const removeForDeletedOrganization = Effect.fn(
				"EnterpriseSsoService.removeForDeletedOrganization",
			)(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const row = yield* loadConnectionRow(orgId)
				yield* Effect.annotateCurrentSpan({ "maple.sso.configured": Option.isSome(row) })
				if (Option.isNone(row)) return
				// Without Clerk configured its side cannot be reached, and refusing would block the
				// deletion for good: the ids are logged so what is left there can be removed by hand.
				if (!clerk.available) {
					return yield* Effect.logWarning(
						"Organization deleted with an SSO connection the identity service could not be asked to remove",
					).pipe(
						Effect.annotateLogs({
							orgId,
							"maple.sso.connection_id": row.value.clerkConnectionId,
							"maple.sso.directory_id": row.value.clerkDirectoryId ?? "none",
						}),
					)
				}
				yield* dropConnection(orgId, row.value)
			})

			const issued = (orgId: OrgId, directory: ClerkSsoDirectory) =>
				Effect.gen(function* () {
					const token = directory.api_key
					if (token === undefined || token === null || token === "") {
						return yield* new EnterpriseSsoUnavailableError({
							message: "Clerk returned no SCIM token",
						})
					}
					// The token exists only in this response, so a failed refresh must not swallow it.
					const document = yield* get(orgId).pipe(
						Effect.catch((error) =>
							Effect.logWarning("SSO document refresh failed after issuing a SCIM token").pipe(
								Effect.annotateLogs({ orgId, error: error.message }),
								Effect.andThen(loadDomains(orgId)),
								Effect.map(
									(domains) =>
										new EnterpriseSsoDocument({
											ssoEntitled: true,
											scimEntitled: true,
											domains: Arr.sort(Arr.map(domains, toDomainDocument), byDomain),
											connection: null,
											directory: toDirectoryDocument(directory),
											roleMappings: [],
											groups: [],
											bypassUsers: [],
										}),
								),
								Effect.orElseSucceed(
									() =>
										new EnterpriseSsoDocument({
											ssoEntitled: true,
											scimEntitled: true,
											domains: [],
											connection: null,
											directory: toDirectoryDocument(directory),
											roleMappings: [],
											groups: [],
											bypassUsers: [],
										}),
								),
							),
						),
					)
					// The token's own directory, even if a refresh raced a replacement.
					return new ScimTokenIssued({
						document: new EnterpriseSsoDocument({
							...document,
							directory: toDirectoryDocument(directory),
						}),
						token,
					})
				})

			const createDirectory = Effect.fn("EnterpriseSsoService.createDirectory")(function* (
				orgId: OrgId,
			) {
				yield* requireEntitled(orgId, "scim")
				yield* Effect.annotateCurrentSpan({ orgId })
				const reconciled = yield* reconcileRow(orgId)
				if (Option.isNone(reconciled)) {
					return yield* new EnterpriseSsoNotFoundError({
						message: "Connect an identity provider first.",
					})
				}
				const row = reconciled.value
				if (row.clerkDirectoryId !== null) {
					return yield* new EnterpriseSsoConflictError({
						message: "SCIM provisioning is already set up. Rotate its token to get a new one.",
					})
				}
				const connection = yield* clerk
					.getConnection(row.clerkConnectionId)
					.pipe(Effect.mapError(fromClerk))
				const directory = yield* Effect.uninterruptible(
					Effect.gen(function* () {
						const created = yield* clerk
							.createDirectory(row.clerkConnectionId, directoryProviderFor(connection.provider))
							.pipe(Effect.mapError(fromClerk))
						const dropCreated = undo("directory", clerk.deleteDirectory(created.id))
						const now = yield* Clock.currentTimeMillis
						// Claims the slot only if still empty: of two concurrent set-ups, one wins.
						const claimed = yield* dbExecute((db) =>
							db.run(
								PG.update(OrgSsoConnections)
									.set({ clerkDirectoryId: created.id, updatedAt: now })
									.where(($) => [
										$.orgId.eq(orgId),
										// The connection it was made for: a replaced connection must not inherit it.
										$.clerkConnectionId.eq(row.clerkConnectionId),
										$.clerkDirectoryId.isNull(),
									])
									.returning("orgId"),
							),
						).pipe(Effect.onError(() => dropCreated))
						if (claimed.length === 0) {
							yield* dropCreated
							return yield* new EnterpriseSsoConflictError({
								message:
									"SCIM provisioning is already set up. Rotate its token to get a new one.",
							})
						}
						return created
					}),
				)
				return yield* issued(orgId, directory)
			})

			const rotateDirectoryToken = Effect.fn("EnterpriseSsoService.rotateDirectoryToken")(function* (
				orgId: OrgId,
			) {
				// No add-on check: a leaked token must be replaceable after the plan ends.
				yield* requireClerk
				yield* Effect.annotateCurrentSpan({ orgId })
				const directoryId = yield* requireConnectionRow(orgId).pipe(
					Effect.flatMap(requireDirectoryId),
				)
				const directory = yield* clerk
					.rotateDirectoryKey(directoryId)
					.pipe(Effect.mapError(fromClerk))
				// The old key is already retiring: a failed timestamp write must not swallow the new one.
				yield* touch(orgId).pipe(
					Effect.catch((error) =>
						Effect.logWarning("SSO timestamp update failed after rotating a SCIM token").pipe(
							Effect.annotateLogs({ orgId, error: error.message }),
						),
					),
				)
				return yield* issued(orgId, directory)
			})

			const setDirectoryState = Effect.fn("EnterpriseSsoService.setDirectoryState")(function* (
				orgId: OrgId,
				paused: boolean,
			) {
				if (!paused) yield* requireEntitled(orgId, "scim")
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.directory_paused": paused })
				const directoryId = yield* requireConnectionRow(orgId).pipe(
					Effect.flatMap(requireDirectoryId),
				)
				yield* clerk.updateDirectory(directoryId, { paused }).pipe(Effect.mapError(fromClerk))
				yield* touch(orgId)
				return yield* get(orgId)
			})

			const deleteDirectory = Effect.fn("EnterpriseSsoService.deleteDirectory")(function* (
				orgId: OrgId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const directoryId = yield* requireConnectionRow(orgId).pipe(
					Effect.flatMap(requireDirectoryId),
				)
				yield* dropDirectory(orgId, directoryId)
				return yield* get(orgId)
			})

			const setRoleMappings = Effect.fn("EnterpriseSsoService.setRoleMappings")(function* (
				orgId: OrgId,
				mappings: ReadonlyArray<{ readonly groupId: string; readonly role: SsoMappedRole }>,
			) {
				yield* requireEntitled(orgId, "scim")
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.role_mappings": mappings.length })
				const directoryId = yield* requireConnectionRow(orgId).pipe(
					Effect.flatMap(requireDirectoryId),
				)
				const groupIds = Arr.map(mappings, (m) => m.groupId)
				if (new Set(groupIds).size !== groupIds.length) {
					return yield* new EnterpriseSsoInvalidError({
						message: "Map each group to one role only.",
					})
				}
				const roles = yield* clerk.listRoles.pipe(Effect.mapError(fromClerk))
				const roleIds = new Map(Arr.map(roles, (r) => [r.key, r.id] as const))
				const resolved = yield* Effect.forEach(mappings, (m) => {
					const roleId = roleIds.get(m.role)
					return roleId === undefined
						? Effect.fail(
								new EnterpriseSsoInvalidError({
									message: `The ${m.role} role does not exist in this deployment.`,
								}),
							)
						: Effect.succeed({ groupId: m.groupId, roleId })
				})
				yield* clerk.replaceRoleMappings(directoryId, resolved).pipe(Effect.mapError(fromClerk))
				// Clerk applies a mapping when the IdP next pushes the group, not on save (seen live):
				// existing members change role on the IdP's next sync.
				yield* clerk
					.updateDirectory(directoryId, { group_role_mapping_enabled: true })
					.pipe(Effect.mapError(fromClerk))
				yield* touch(orgId)
				return yield* get(orgId)
			})

			/**
			 * The user's verified email domains another org's connection serves. Clerk's bypass entry
			 * is per user across every connection serving them, so adding or removing one for such a
			 * user would also change that other org's SSO.
			 */
			const coveredElsewhere = (
				userId: UserId,
				connectionId: string,
				ownDomains: ReadonlyArray<string>,
			) =>
				clerk.verifiedEmailDomains(userId).pipe(
					Effect.flatMap((domains) =>
						clerk.domainsClaimedElsewhere(
							connectionId,
							Arr.filter(domains, (d) => !Arr.contains(ownDomains, d)),
						),
					),
				)

			const addBypassUser = Effect.fn("EnterpriseSsoService.addBypassUser")(function* (
				orgId: OrgId,
				userId: UserId,
			) {
				yield* requireEntitled(orgId, "sso")
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.bypass_user": userId })
				const row = yield* requireConnectionRow(orgId)
				// The allowlist is instance-wide, so Maple scopes it: a member of this org with a
				// verified email on this connection's domains, so the entry serves only this org.
				const [connection, member, emailDomains] = yield* Effect.all(
					[
						clerk.getConnection(row.clerkConnectionId),
						clerk.isMember(orgId, userId),
						clerk.verifiedEmailDomains(userId),
					],
					{ concurrency: "unbounded" },
				).pipe(Effect.mapError(fromClerk))
				if (!member) {
					return yield* new EnterpriseSsoInvalidError({
						message: "Only members of this organization can be added.",
					})
				}
				if (!Arr.some(emailDomains, (d) => Arr.contains(connection.domains, d))) {
					return yield* new EnterpriseSsoInvalidError({
						message: `Only people with a verified email on ${Arr.join(connection.domains, ", ")} can bypass SSO.`,
					})
				}
				// Clerk's entry exempts the user from every connection that serves them, so a user
				// another org's SSO also covers cannot be exempted from here.
				const elsewhere = yield* clerk
					.domainsClaimedElsewhere(
						row.clerkConnectionId,
						Arr.filter(emailDomains, (d) => !Arr.contains(connection.domains, d)),
					)
					.pipe(Effect.mapError(fromClerk))
				if (elsewhere.length > 0) {
					return yield* new EnterpriseSsoInvalidError({
						message:
							"This person is also covered by another organization's single sign-on, so they cannot bypass SSO from here.",
					})
				}
				yield* clerk.addBypassUser(userId).pipe(Effect.mapError(fromClerk))
				return yield* get(orgId)
			})

			const removeBypassUser = Effect.fn("EnterpriseSsoService.removeBypassUser")(function* (
				orgId: OrgId,
				userId: UserId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.bypass_user": userId })
				const row = yield* requireConnectionRow(orgId)
				// The allowlist is instance-wide: only entries this org's connection serves are its to remove.
				const listed = yield* clerk
					.listBypassUsers(row.clerkConnectionId)
					.pipe(Effect.mapError(fromClerk))
				if (!Arr.some(listed, (u) => u.userId === userId)) {
					return yield* new EnterpriseSsoNotFoundError({
						message: "That person is not on this organization's bypass list.",
					})
				}
				const connection = yield* clerk
					.getConnection(row.clerkConnectionId)
					.pipe(Effect.mapError(fromClerk))
				const elsewhere = yield* coveredElsewhere(
					userId,
					row.clerkConnectionId,
					connection.domains,
				).pipe(Effect.mapError(fromClerk))
				if (elsewhere.length > 0) {
					return yield* new EnterpriseSsoConflictError({
						message:
							"This person is also covered by another organization's single sign-on. Removing them here would remove that organization's break-glass access too; contact support.",
					})
				}
				yield* clerk.removeBypassUser(userId).pipe(Effect.mapError(fromClerk))
				return yield* get(orgId)
			})

			const removeFormerMemberBypass = Effect.fn("EnterpriseSsoService.removeFormerMemberBypass")(
				function* (orgId: OrgId, userId: UserId) {
					yield* Effect.annotateCurrentSpan({ orgId, "maple.sso.bypass_user": userId })
					const row = yield* loadConnectionRow(orgId)
					// No row in this region, or no Clerk: there is no list here to take them off.
					if (Option.isNone(row) || !clerk.available) return "not_listed" as const
					const { clerkConnectionId } = row.value
					const outcome = yield* Effect.gen(function* () {
						const listed = yield* clerk.listBypassUsers(clerkConnectionId).pipe(orEmpty)
						if (!Arr.some(listed, (u) => u.userId === userId)) return "not_listed" as const
						// Deliveries are unordered: someone who rejoined since keeps the entry they hold now.
						if (yield* clerk.isMember(orgId, userId)) return "kept" as const
						const connection = yield* orMissing(clerk.getConnection(clerkConnectionId))
						// Clerk drops a deleted connection's entries itself.
						if (Option.isNone(connection)) return "not_listed" as const
						const elsewhere = yield* coveredElsewhere(
							userId,
							clerkConnectionId,
							connection.value.domains,
						)
						// The entry is per user across the instance: another organization still needs it.
						if (elsewhere.length > 0) return "kept" as const
						yield* clerk.removeBypassUser(userId)
						return "removed" as const
					}).pipe(
						// The user or the entry went away meanwhile: nothing left to remove.
						Effect.catchIf(
							(e) => e.status === 404,
							() => Effect.succeed("not_listed" as const),
						),
						Effect.mapError(unavailable),
					)
					yield* Effect.annotateCurrentSpan({ "maple.sso.bypass_outcome": outcome })
					return outcome
				},
			)

			const applyDirectoryGroup = Effect.fn("EnterpriseSsoService.applyDirectoryGroup")(function* (
				event: DirectoryGroupEvent,
			) {
				yield* Effect.annotateCurrentSpan({
					"maple.sso.directory_id": event.directoryId,
					"maple.sso.group_deleted": event.deleted,
				})
				// Cross-org on purpose: the directory id is what tells us which org, if any, is ours.
				const owners = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgSsoConnections)
							.select()
							.where(($) => [$.clerkDirectoryId.eq(event.directoryId)])
							.limit(1),
					),
				)
				const owner = owners[0]
				if (owner === undefined) return "not_here" as const
				const orgId = owner.orgId
				// A deletion is a tombstone and only newer events win, so a late redelivered
				// update cannot bring a deleted group back.
				const set = {
					displayName: event.displayName,
					updatedAt: event.updatedAt,
					deletedAt: event.deleted ? event.updatedAt : null,
				}
				yield* dbExecute((db) =>
					db.run(
						PG.insertInto(OrgDirectoryGroups)
							.values({ orgId, directoryId: event.directoryId, groupId: event.groupId, ...set })
							.onConflictDoUpdate({
								target: ["directoryId", "groupId"],
								// Ties go to the deletion: a redelivered update at the same instant stays dead.
								where: ($) =>
									PG.and(
										$.orgId.eq(orgId),
										event.deleted
											? $.updatedAt.lte(event.updatedAt)
											: $.updatedAt.lt(event.updatedAt),
									),
								set,
							}),
					),
				)
				return "applied" as const
			})

			const confirmDeprovisioned = Effect.fn("EnterpriseSsoService.confirmDeprovisioned")(function* (
				userId: UserId,
			) {
				const state = yield* clerk.isDeprovisioned(userId).pipe(
					// A blip should not decide it: retry briefly, then fail closed.
					Effect.retry({ schedule: Schedule.exponential(Duration.millis(200)), times: 2 }),
					Effect.catch((error) =>
						Effect.logWarning(
							"Could not confirm a deprovisioning with Clerk; sweeping anyway",
						).pipe(Effect.annotateLogs({ userId, error: error.message }), Effect.as(true)),
					),
				)
				yield* Effect.annotateCurrentSpan({ "maple.sso.still_deprovisioned": state })
				return state
			})

			return {
				confirmDeprovisioned,
				get,
				getSummary,
				addDomain,
				verifyDomain,
				removeDomain,
				createConnection,
				updateConnection,
				setEnforcement,
				deleteConnection,
				removeForDeletedOrganization,
				createDirectory,
				rotateDirectoryToken,
				setDirectoryState,
				deleteDirectory,
				setRoleMappings,
				addBypassUser,
				removeBypassUser,
				removeFormerMemberBypass,
				applyDirectoryGroup,
			} satisfies EnterpriseSsoServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				AutumnClient.layer,
				BillingCustomerResolver.layer,
				ClerkSsoGateway.layer,
				DnsTxtResolver.layer,
			),
		),
	)

	/** Serves only the webhook's paths, for route tests; settings calls fail. */
	static readonly webhookOnly = (
		apply: EnterpriseSsoServiceApi["applyDirectoryGroup"],
		confirmDeprovisioned: EnterpriseSsoServiceApi["confirmDeprovisioned"] = () => Effect.succeed(true),
		removeFormerMemberBypass: EnterpriseSsoServiceApi["removeFormerMemberBypass"] = () =>
			Effect.succeed("not_listed"),
	) => {
		const unserved = Effect.fail(
			new EnterpriseSsoUnavailableError({ message: "webhookOnly serves webhooks only" }),
		)
		return Layer.succeed(this, {
			get: () => unserved,
			getSummary: () => unserved,
			addDomain: () => unserved,
			verifyDomain: () => unserved,
			removeDomain: () => unserved,
			createConnection: () => unserved,
			updateConnection: () => unserved,
			setEnforcement: () => unserved,
			deleteConnection: () => unserved,
			removeForDeletedOrganization: () => unserved,
			createDirectory: () => unserved,
			rotateDirectoryToken: () => unserved,
			setDirectoryState: () => unserved,
			deleteDirectory: () => unserved,
			setRoleMappings: () => unserved,
			addBypassUser: () => unserved,
			removeBypassUser: () => unserved,
			removeFormerMemberBypass,
			applyDirectoryGroup: apply,
			confirmDeprovisioned,
		})
	}
}
