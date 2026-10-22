/**
 * Who a turn — and a mutation approved on one — acts as.
 *
 * Its own module rather than functions in `turn-runner`, because both readers need them and only
 * one of them is a turn: applying an approved proposal resolves the same identity without the
 * model, the agent engine or any of the graph `turn-runner` pulls in at module scope.
 */
import {
	decodeChatTurnTenant,
	type ChatTurnOrigin,
	type ChatTurnTenantEncoded,
} from "@maple/domain/chat-session"
import { type OrgId, UserId } from "@maple/domain/primitives"
import { chatConnectorAgentName } from "@maple/domain/system-agents"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import type { ActorDocument } from "@maple/domain/http"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { Cause, Effect, Option, Schema } from "effect"

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
 * Fail closed on purpose: a Clerk blip must not silently fall back to the connector identity.
 */
export class LinkedUserNotPermitted extends Schema.TaggedError<LinkedUserNotPermitted>()(
	"@maple/ai/LinkedUserNotPermitted",
	{
		message: Schema.String,
		/** Which of the two it was. They read the same to the person in the channel, not to an operator. */
		reason: Schema.Literals(["not_a_member", "unavailable"]),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/**
 * Act as the Maple user a chat account is linked to, under the roles they hold in the org now.
 *
 * Roles come from the membership directory, never frozen at link time. That read is cached (a
 * per-isolate memo, then a shared tier), so a demotion lands within the cache's revocation window;
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
		authMode: "self_hosted" as const,
		turnOrigin: origin,
	} satisfies TenantContext
})

const decodeUserId = Schema.decodeUnknownOption(UserId)

/**
 * Who a turn's tools run as: the linked Maple user when the connector named one, the connector's
 * agent actor otherwise, and the tenant itself for an app or autonomous turn.
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
		return yield* linkedUserTenant(tenant.orgId, userId.value, origin)
	}
	return yield* withConnectorActor(tenant, origin)
})
