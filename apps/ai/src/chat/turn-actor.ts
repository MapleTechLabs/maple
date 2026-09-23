/**
 * Who a connector turn — and a mutation approved on one — acts as.
 *
 * Its own module rather than a function in `turn-runner`, because both readers need it and only
 * one of them is a turn: applying an approved proposal resolves the same actor without the model,
 * the agent engine or any of the graph `turn-runner` pulls in at module scope.
 */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import { chatConnectorAgentName } from "@maple/domain/system-agents"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import type { ActorDocument } from "@maple/domain/http"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { Cause, Effect, Option } from "effect"

/**
 * Pin a connector turn to the agent actor that answers for that connector, one `ensureAgentActor`
 * per turn.
 *
 * Everything that asks "who did this" already prefers a pinned `actorId` — the audit log, an issue
 * claim, a comment — and for a connector turn that is the honest answer: a person on a chat
 * platform drove it, holding no Maple identity, so the connector acts and who asked is metadata.
 * Without the pin those paths would fall back to the placeholder user id the tenant carries.
 */
export const withConnectorActor = Effect.fn("chat.connectorActor")(function* (
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
