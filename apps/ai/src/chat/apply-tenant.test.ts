/**
 * Whose authority an approved proposal runs under.
 *
 * This is the whole security model of approving a write, so each case is pinned separately:
 *
 *   - a person in the app acts as themselves, with the tenant and roles the route authenticated;
 *   - a connector that cannot name the clicker acts as the org-level connector identity, which
 *     carries `org:admin` because there is no person whose roles could be read;
 *   - a connector that CAN name them acts as that Maple user, with the roles they hold in the org
 *     right now — read live, never frozen at link time, and never widened here;
 *   - anything that cannot be found out refuses, because the alternative is silently downgrading
 *     an approval to the identity that does carry `org:admin`.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { AuthorizationUnavailableError, ErrorPersistenceError, RoleName } from "@maple/domain/http"
import { CONNECTOR_TENANT_USER_ID, type ChatConnectorOrigin } from "@maple/domain/chat-session"
import { ActorId, OrgId, UserId } from "@maple/domain/primitives"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { auditAttribution } from "@maple/backend/services/audit/audit-access"
import { resolveTenant } from "./apply-proposal"

const ORG = Schema.decodeSync(OrgId)("org_1")
const ADA = Schema.decodeSync(UserId)("user_ada")
const MEMBER = Schema.decodeSync(RoleName)("org:member")
const ADMIN = Schema.decodeSync(RoleName)("org:admin")
const CONNECTOR_ACTOR = Schema.decodeSync(ActorId)("00000000-0000-4000-8000-00000000c0de")

const APPROVER: ChatConnectorOrigin = {
	kind: "connector",
	connectorId: "testchat",
	workspaceId: "w1",
	externalUserId: "u-1",
	displayName: "Ada",
}

const die = () => Effect.die("not reached in this test")

/** A connector turn's actor lookup, which only the org-level branch reaches. */
const unusedActors = {
	registerAgent: die,
	listAgents: die,
	lookupActor: die,
	ensureUserActor: die,
	actorExists: die,
	ensureSystemActor: die,
	ensureAgentActor: die,
	touchActor: die,
	collectActorDocs: die,
}

const noActors = Layer.succeed(ErrorActorsService, unusedActors)

/** Actors that answer with `actor`, or fail the lookup when it is absent. */
const actorsThat = (actor: ActorId | undefined): Layer.Layer<ErrorActorsService> =>
	Layer.succeed(ErrorActorsService, {
		...unusedActors,
		ensureAgentActor: () =>
			actor === undefined
				? Effect.fail(new ErrorPersistenceError({ message: "actors table unavailable" }))
				: Effect.succeed({ id: actor, orgId: ORG, kind: "agent", name: "chat-connector-testchat" }),
	} as ErrorActorsService)

const memberships = (verify: OrgMembershipService["verify"]): Layer.Layer<OrgMembershipService> =>
	Layer.succeed(OrgMembershipService, { verify })

const proposal = (actingUserId?: UserId) => ({
	env: {},
	sessionId: `${ORG}:bot-testchat-c1`,
	approver: APPROVER,
	tool: "create_alert_rule",
	input: {},
	...(actingUserId === undefined ? undefined : { actingUserId }),
})

describe("whose authority an approval runs under", () => {
	it.effect("runs an app approval as the caller, under their own roles, audited as them", () =>
		Effect.gen(function* () {
			const tenant = yield* resolveTenant(ORG, {
				env: {},
				sessionId: `${ORG}:tab-1`,
				approver: { kind: "app" },
				tenant: { orgId: ORG, userId: ADA, roles: [MEMBER], authMode: "clerk" },
				tool: "create_alert_rule",
				input: {},
			}).pipe(
				// Neither lookup is consulted: the route already authenticated the caller.
				Effect.provide(Layer.mergeAll(memberships(die), noActors)),
			)

			assert.strictEqual(tenant.userId, ADA)
			assert.deepStrictEqual(tenant.roles, [MEMBER])
			assert.isUndefined(tenant.actorId)
			assert.deepStrictEqual(tenant.turnOrigin, { kind: "app" })
			// The entry reads exactly as the by-value route's did: the user, from the dashboard.
			assert.deepStrictEqual(auditAttribution(tenant, undefined), {
				actor: { type: "user", userId: ADA },
				source: "dashboard",
			})
		}),
	)

	it.effect("gives a linked user their OWN roles, and grants nothing", () =>
		Effect.gen(function* () {
			const tenant = yield* resolveTenant(ORG, proposal(ADA)).pipe(
				Effect.provide(
					Layer.mergeAll(
						memberships(() => Effect.succeed(Option.some({ orgId: ORG, role: MEMBER }))),
						noActors,
					),
				),
			)

			assert.strictEqual(tenant.userId, ADA)
			assert.deepStrictEqual(tenant.roles, [MEMBER])
			// A tool that needs an admin now refuses them, exactly as it would in the app.
			assert.notInclude(tenant.roles, ADMIN)
			// No pinned agent actor: a real person acted, so the audit log names them.
			assert.isUndefined(tenant.actorId)
			// The chat account they clicked from still rides along as forensic context.
			assert.deepStrictEqual(tenant.turnOrigin, APPROVER)
		}),
	)

	it.effect("refuses a linked user who is no longer in the organization", () =>
		Effect.gen(function* () {
			// The link outlived the membership. Falling back to the org-level identity here would
			// hand `org:admin` to somebody who was removed.
			const failure = yield* resolveTenant(ORG, proposal(ADA)).pipe(
				Effect.provide(
					Layer.mergeAll(
						memberships(() => Effect.succeed(Option.none())),
						noActors,
					),
				),
				Effect.flip,
			)

			assert.strictEqual(failure._tag, "@maple/ai/ApproverNotPermitted")
		}),
	)

	it.effect("fails closed when membership cannot be checked at all", () =>
		Effect.gen(function* () {
			const failure = yield* resolveTenant(ORG, proposal(ADA)).pipe(
				Effect.provide(
					Layer.mergeAll(
						memberships(() =>
							Effect.fail(
								new AuthorizationUnavailableError({
									message: "the directory was unreachable",
								}),
							),
						),
						noActors,
					),
				),
				Effect.flip,
			)

			// "Could not find out" is not "allowed": a blip must not downgrade the approval.
			assert.strictEqual(failure._tag, "@maple/ai/ApproverNotPermitted")
		}),
	)

	it.effect("acts as the org, with `org:admin`, when the connector cannot name who clicked", () =>
		Effect.gen(function* () {
			const tenant = yield* resolveTenant(ORG, proposal()).pipe(
				// The membership check is never consulted: there is no user to check. The actor lookup
				// failing must not cost an answer either; `withConnectorActor` absorbs it.
				Effect.provide(Layer.mergeAll(memberships(die), actorsThat(undefined))),
			)

			// The placeholder user, because nobody can be named — and the one role the mutating
			// tools check, granted here and only here.
			assert.strictEqual(tenant.userId, CONNECTOR_TENANT_USER_ID)
			assert.deepStrictEqual(tenant.roles, [ADMIN])
			assert.deepStrictEqual(tenant.turnOrigin, APPROVER)
		}),
	)

	it.effect("pins the connector's agent actor on that path, so the audit log names it", () =>
		Effect.gen(function* () {
			const tenant = yield* resolveTenant(ORG, proposal()).pipe(
				Effect.provide(Layer.mergeAll(memberships(die), actorsThat(CONNECTOR_ACTOR))),
			)

			assert.strictEqual(tenant.actorId, CONNECTOR_ACTOR)
		}),
	)
})
