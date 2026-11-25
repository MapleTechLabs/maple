/**
 * Who a turn — and a mutation approved on one — acts as.
 *
 * Its own module rather than functions in `turn-runner`, because both readers need them and only
 * one of them is a turn: applying an approved proposal resolves the same identity without the
 * model, the agent engine or any of the graph `turn-runner` pulls in at module scope.
 */
import {
	ANONYMOUS_CONNECTOR_GRANTS,
	decodeChatTurnTenant,
	type ChatTurnOrigin,
	type ChatTurnTenantEncoded,
} from "@maple/domain/chat-session"
import { type OrgId, UserId } from "@maple/primitives"
import { chatConnectorAgentName } from "@maple/domain/system-agents"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { ActorDocument, TenantContext } from "@maple/domain/http"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import * as Policy from "@maple/domain/policy"
import { RoleName } from "@maple/primitives"
import { Array as Arr, Cause, Effect, Option, Schema } from "effect"

/**
 * Decode the wire projection back into the `apps/api` tenant type.
 *
 * The Durable Object receives a plain, structured-cloneable object (RPC refuses class instances),
 * so the brands have to be re-established on this side before the value is used as a
 * `TenantContext`.
 *
 * The origin rides along because it is what the audit log attributes the turn's tool calls by —
 * the tenant's user id answers that only for an app turn.
 */
export const toTenantContext = (encoded: ChatTurnTenantEncoded, origin: ChatTurnOrigin): TenantContext => {
	const tenant = decodeChatTurnTenant(encoded)
	return {
		orgId: tenant.orgId,
		userId: tenant.userId,
		roles: [...tenant.roles],
		// Never wider than the roles: a turn recorded before permissions holds what its roles grant,
		// and a connector turn nobody is named on (from a host that predates its grants) only reads.
		permissions:
			tenant.permissions ??
			(origin.kind === "connector" && origin.actingUserId === undefined
				? ANONYMOUS_CONNECTOR_GRANTS
				: Policy.grantsOf(tenant.roles)),
		authMode: tenant.authMode,
		turnOrigin: origin,
		...(!(tenant.actorId === undefined) ? { actorId: tenant.actorId } : undefined),
	}
}

/**
 * Pin a connector turn to the agent actor that answers for that connector, one `ensureAgentActor`
 * per turn.
 *
 * Everything that asks "who did this" already prefers a pinned `actorId` — the audit log, an issue
 * claim, a comment — and for a connector turn that is the honest answer: a person on a chat
 * platform drove it, holding no Maple identity, so the connector acts and who asked is metadata.
 * Without the pin those paths would fall back to the placeholder user id the tenant carries.
 */
export const withConnectorActor = Effect.fn("ChatTurnActor.withConnectorActor")(function* (
	tenant: TenantContext,
	origin: ChatTurnOrigin,
) {
	if (origin.kind !== "connector") return tenant
	const actors = yield* ErrorActorsService
	const actor = yield* actors
		.ensureAgentActor(tenant.orgId, chatConnectorAgentName(origin.connectorId))
		.pipe(
			Effect.asSome,
			// A lookup that failed or died must not cost an answer: the entry still names the
			// connector, from the origin and the label it carries. Interrupts stay interrupts.
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logWarning("Could not resolve the connector's agent actor").pipe(
							Effect.annotateLogs({
								connector: origin.connectorId,
								error: summarizeCause(cause),
							}),
							Effect.as(Option.none<ActorDocument>()),
						),
			),
		)
	return Option.match(actor, {
		onNone: () => tenant,
		onSome: (resolved) => ({ ...tenant, actorId: resolved.id }),
	})
})

/**
 * The linked Maple user may not act in this org, or nobody can find out whether they may.
 *
 * Fail closed on purpose: a Clerk blip must not silently fall back to the connector identity,
 * which is a turn for nobody in particular and never one a change is applied as.
 */
export class LinkedUserNotPermitted extends Schema.TaggedError<LinkedUserNotPermitted>()(
	"@maple/ai/LinkedUserNotPermitted",
	{
		message: Schema.String,
		/** Which one it was. They read much the same to the person in the channel, not to an operator. */
		reason: Schema.Literals(["not_a_member", "unavailable", "not_linked", "not_permitted"]),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/**
 * Act as the Maple user a chat account is linked to, under the permissions they hold in the org now.
 *
 * Their role, and a custom role's permissions, come from the membership directory, never frozen at
 * link time. That read is cached (a per-isolate memo, then a shared tier), so a demotion lands
 * within the cache's revocation window;
 * the membership webhook closes it from the other side. No `actorId`: a real user acted, so the
 * audit log names them, and `turnOrigin` records which chat account it was.
 */
export const linkedUserTenant = Effect.fn("ChatTurnActor.linkedUserTenant")(function* (
	orgId: OrgId,
	userId: UserId,
	origin: ChatTurnOrigin,
) {
	const memberships = yield* OrgMembershipService
	const membership = yield* memberships.verify(userId, orgId).pipe(
		Effect.mapError(
			(cause) =>
				new LinkedUserNotPermitted({
					reason: "unavailable",
					message: "Maple could not check whether you are still a member of this organization.",
					cause,
				}),
		),
	)
	if (Option.isNone(membership)) {
		return yield* new LinkedUserNotPermitted({
			reason: "not_a_member",
			message: "The Maple account this chat account is linked to is no longer in this organization.",
		})
	}
	return {
		orgId,
		userId,
		roles: [membership.value.role],
		permissions: Policy.grantsOf([membership.value.role], membership.value.customPermissions),
		authMode: "self_hosted" as const,
		turnOrigin: origin,
	} satisfies TenantContext
})

const decodeUserId = Schema.decodeUnknownOption(UserId)
const decodeRoles = Schema.decodeUnknownOption(Schema.Array(RoleName))
const decodePermissions = Schema.decodeUnknownOption(Schema.Array(Policy.PermissionName))

type AutonomousOrigin = Extract<ChatTurnOrigin, { readonly kind: "autonomous" }>

/** A person nobody can name or confirm: they answer for the pass, holding nothing. */
const NOBODY = { kind: "person", roles: [], permissions: [] } as const satisfies NonNullable<
	TenantContext["turnStarter"]
>

/**
 * Who answers for an unattended pass. A person does so with only what they hold both in the org now
 * and on the credential they started it with, and with nothing when that credential could not read
 * data sources. An unreadable membership answers as nobody.
 */
export const turnStarterOf = Effect.fn("ChatTurnActor.turnStarterOf")(function* (
	orgId: OrgId,
	origin: AutonomousOrigin,
) {
	const startedBy = origin.startedBy
	if (startedBy?.kind === "producer") return { kind: "producer" } as const
	// What the starter's permissions gate here is a query on a data source, so a credential whose
	// scopes did not reach them answers as nobody, whatever it held.
	if (startedBy?.mayReadDataSources !== true) return NOBODY
	const roles = decodeRoles(startedBy.roles)
	if (Option.isNone(roles)) return NOBODY
	// A start recorded before permissions holds what its roles grant, never more.
	const held =
		startedBy.permissions === undefined
			? Option.some(Policy.grantsOf(roles.value))
			: decodePermissions(startedBy.permissions)
	if (Option.isNone(held)) return NOBODY
	const then = { kind: "person", roles: roles.value, permissions: held.value } as const
	const memberships = yield* OrgMembershipService
	// No directory to ask (self-hosted): what the credential held is the only answer there is.
	if (memberships.directory === "none") return then
	const userId = Option.flatMap(Option.fromNullishOr(startedBy.userId), decodeUserId)
	if (Option.isNone(userId)) return NOBODY
	const membership = yield* memberships
		.verify(userId.value, orgId)
		.pipe(
			Effect.catch((error) =>
				Effect.logWarning(
					"Could not read the roles of the person who started an unattended pass",
				).pipe(Effect.annotateLogs({ orgId, error: error.message }), Effect.as(Option.none())),
			),
		)
	if (Option.isNone(membership)) return NOBODY
	const now = Policy.grantsOf([membership.value.role], membership.value.customPermissions)
	return {
		kind: "person",
		roles: [membership.value.role],
		permissions: Arr.intersection(then.permissions, now),
	} as const
})

/**
 * Who a turn's tools run as: the linked Maple user when the connector named one, the connector's
 * agent actor otherwise, the tenant itself for an app turn, and for an unattended one the tenant
 * with who answers for it.
 */
export const turnTenant = Effect.fn("ChatTurnActor.turnTenant")(function* (
	tenant: TenantContext,
	origin: ChatTurnOrigin,
) {
	if (origin.kind === "connector" && origin.actingUserId !== undefined) {
		// The origin crosses the Durable Object hop in its encoded form, so the brand is re-checked
		// here. An id that does not decode names nobody, and that refuses rather than reading as the
		// connector.
		const userId = decodeUserId(origin.actingUserId)
		if (Option.isNone(userId)) {
			return yield* new LinkedUserNotPermitted({
				reason: "unavailable",
				message: "Maple could not tell which Maple user you are.",
			})
		}
		const linked: TenantContext = yield* linkedUserTenant(tenant.orgId, userId.value, origin)
		// Someone who may not ask Maple AI in the app is not answered in a channel either.
		yield* Policy.check(
			linked.permissions,
			"ai:ask",
			(denial) => new LinkedUserNotPermitted({ reason: "not_permitted", message: denial.message }),
		)
		return linked
	}
	if (origin.kind === "autonomous") {
		const turnStarter = yield* turnStarterOf(tenant.orgId, origin)
		return { ...tenant, turnStarter } satisfies TenantContext
	}
	return yield* withConnectorActor(tenant, origin)
})
