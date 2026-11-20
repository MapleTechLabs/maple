/**
 * Whose authority an approved proposal runs under.
 *
 * This is the whole security model of approving a write, so each case is pinned separately:
 *
 *   - a person in the app acts as themselves, with the tenant and roles the route authenticated;
 *   - a connector approver acts as the Maple user they are linked to, with the roles they hold in
 *     the org right now, read live, never frozen at link time, and never widened here;
 *   - a click that names no Maple user applies nothing: there is no identity to apply it as;
 *   - anything that cannot be found out refuses, because "could not find out" is not "allowed".
 */
import { assert, describe, it } from "@effect/vitest"
import * as Policy from "@maple/domain/policy"
import { Effect, Layer, Schema } from "effect"
import {
	ActorDocument,
	AuthorizationUnavailableError,
	ErrorPersistenceError,
	RoleName,
	type TenantContext,
} from "@maple/domain/http"
import {
	CONNECTOR_TENANT_USER_ID,
	connectorTurnTenant,
	type ChatConnectorOrigin,
} from "@maple/domain/chat-session"
import { ActorId, OrgId, UserId } from "@maple/primitives"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { auditAttribution } from "@maple/backend/services/audit/audit-access"
import { resolveTenant } from "./apply-proposal"
import { toTenantContext, turnTenant } from "./turn-actor"

const ORG = Schema.decodeSync(OrgId)("org_1")
const ADA = Schema.decodeSync(UserId)("user_ada")
const MEMBER = Schema.decodeSync(RoleName)("org:member")
const ADMIN = Schema.decodeSync(RoleName)("org:admin")
const ANALYST = Schema.decodeSync(RoleName)("org:analyst")
const CUSTOM = Schema.decodeSync(RoleName)("org:custom")
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
const unusedActors: ErrorActorsService["Service"] = {
	registerAgent: die,
	listAgents: die,
	lookupActor: die,
	ensureUserActor: die,
	actorExists: die,
	ensureSystemActor: die,
	ensureAgentActor: die,
	touchActor: die,
	collectActorDocs: die,
	findOwnedAgentActor: die,
}

const noActors = Layer.succeed(ErrorActorsService, unusedActors)

/** Actors that answer with `actor`, or fail the lookup when it is absent. */
const actorsThat = (actor: ActorId | undefined): Layer.Layer<ErrorActorsService> =>
	Layer.succeed(ErrorActorsService, {
		...unusedActors,
		ensureAgentActor: () =>
			actor === undefined
				? Effect.fail(new ErrorPersistenceError({ message: "actors table unavailable" }))
				: Effect.succeed(
						new ActorDocument({
							id: actor,
							type: "agent",
							userId: null,
							agentName: "chat-connector-testchat",
							model: null,
							capabilities: [],
							lastActiveAt: null,
						}),
					),
	})

const memberships = (verify: OrgMembershipService["Service"]["verify"]): Layer.Layer<OrgMembershipService> =>
	Layer.mock(OrgMembershipService)({ directory: "clerk", verify })

/** As the session hands it over: the acting user is whatever the relay sent, checked on arrival. */
const proposal = (actingUserId?: string) => ({
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
			const tenant: TenantContext = yield* resolveTenant(ORG, {
				env: {},
				sessionId: `${ORG}:tab-1`,
				approver: { kind: "app" },
				tenant: { orgId: ORG, userId: ADA, roles: [MEMBER], authMode: "clerk" },
				tool: "create_alert_rule",
				input: {},
			}).pipe(
				// Neither lookup is consulted: the route already authenticated the caller.
				Effect.provide([memberships(die), noActors]),
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
			const tenant: TenantContext = yield* resolveTenant(ORG, proposal(ADA)).pipe(
				Effect.provide([
					memberships(() =>
						Effect.succeedSome({ orgId: ORG, role: MEMBER, customPermissions: [] }),
					),
					noActors,
				]),
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

	/** An app approval as the route encodes it, by a caller holding `permissions` (absent: a record from before them). */
	const appApproval = (
		roles: ReadonlyArray<RoleName>,
		permissions?: Policy.Grants,
		tool = "create_alert_rule",
	) =>
		resolveTenant(ORG, {
			env: {},
			sessionId: `${ORG}:tab-1`,
			approver: { kind: "app" },
			tenant: {
				orgId: ORG,
				userId: ADA,
				roles,
				...(permissions === undefined ? undefined : { permissions }),
				authMode: "clerk",
			},
			tool,
			input: {},
		}).pipe(Effect.provide([memberships(die), noActors]))

	it.effect("refuses an app approval by someone who may not act through Maple AI", () =>
		Effect.gen(function* () {
			const analyst = yield* appApproval([ANALYST]).pipe(Effect.flip)
			const custom = yield* appApproval([CUSTOM], ["telemetry:read", "ai:ask", "alerts:manage"]).pipe(
				Effect.flip,
			)

			for (const failure of [analyst, custom]) {
				assert.strictEqual(failure._tag, "@maple/ai/LinkedUserNotPermitted")
				assert.strictEqual(failure.reason, "not_permitted")
				assert.strictEqual(failure.message, Policy.denialFor("ai:act").message)
			}
		}),
	)

	it.effect(
		"lets an analyst approve a dashboard change, which needs dashboards:edit rather than ai:act",
		() =>
			Effect.gen(function* () {
				const analyst = yield* appApproval([ANALYST], undefined, "create_dashboard")
				const actsWithoutDashboards = yield* appApproval(
					[CUSTOM],
					["telemetry:read", "ai:act"],
					"create_dashboard",
				).pipe(Effect.flip)

				assert.strictEqual(analyst.userId, ADA)
				assert.strictEqual(actsWithoutDashboards.reason, "not_permitted")
				assert.strictEqual(actsWithoutDashboards.message, Policy.denialFor("dashboards:edit").message)
			}),
	)

	it.effect(
		"runs an app approval with the approver's own permissions, and an old record with its roles'",
		() =>
			Effect.gen(function* () {
				const custom = yield* appApproval([CUSTOM], ["ai:act", "alerts:manage"])
				const recordedBefore = yield* appApproval([MEMBER])

				assert.deepStrictEqual(custom.permissions, ["ai:act", "alerts:manage"])
				assert.deepStrictEqual(recordedBefore.permissions, Policy.grantsOf([MEMBER]))
			}),
	)

	it.effect("refuses a linked approver whose custom role cannot act through Maple AI", () =>
		Effect.gen(function* () {
			const failure = yield* resolveTenant(ORG, proposal(ADA)).pipe(
				Effect.provide([
					memberships(() =>
						Effect.succeedSome({
							orgId: ORG,
							role: CUSTOM,
							customPermissions: ["alerts:manage"],
						}),
					),
					noActors,
				]),
				Effect.flip,
			)

			assert.strictEqual(failure.reason, "not_permitted")
		}),
	)

	it.effect("refuses a linked user who is no longer in the organization", () =>
		Effect.gen(function* () {
			// The link outlived the membership, and there is nothing to fall back to.
			const failure = yield* resolveTenant(ORG, proposal(ADA)).pipe(
				Effect.provide([memberships(() => Effect.succeedNone), noActors]),
				Effect.flip,
			)

			assert.strictEqual(failure._tag, "@maple/ai/LinkedUserNotPermitted")
		}),
	)

	it.effect("fails closed when membership cannot be checked at all", () =>
		Effect.gen(function* () {
			const failure = yield* resolveTenant(ORG, proposal(ADA)).pipe(
				Effect.provide([
					memberships(() =>
						Effect.fail(
							new AuthorizationUnavailableError({
								message: "the directory was unreachable",
							}),
						),
					),
					noActors,
				]),
				Effect.flip,
			)

			// "Could not find out" is not "allowed": a blip must not downgrade the approval.
			assert.strictEqual(failure._tag, "@maple/ai/LinkedUserNotPermitted")
		}),
	)

	it.effect("applies nothing for a click that names no Maple user", () =>
		Effect.gen(function* () {
			// What a relay build from before this rule could still send: an approver, and nobody the
			// change would run as. Neither lookup is consulted, and there is no connector identity.
			const failure = yield* resolveTenant(ORG, proposal()).pipe(
				Effect.provide([memberships(die), noActors]),
				Effect.flip,
			)

			assert.strictEqual(failure._tag, "@maple/ai/LinkedUserNotPermitted")
			// Its own reason: nobody was named, which is not the same as a lookup that failed.
			assert.strictEqual(failure.reason, "not_linked")
		}),
	)

	it.effect("applies nothing for an acting user id that does not decode", () =>
		Effect.gen(function* () {
			const failure = yield* resolveTenant(ORG, proposal("")).pipe(
				Effect.provide([memberships(die), noActors]),
				Effect.flip,
			)

			assert.strictEqual(failure.reason, "not_linked")
		}),
	)
})

describe("whose authority a connector turn reads under", () => {
	const asking = (actingUserId?: UserId): ChatConnectorOrigin => ({
		...APPROVER,
		...(actingUserId === undefined ? undefined : { actingUserId }),
	})
	const run = (origin: ChatConnectorOrigin) =>
		turnTenant(toTenantContext(connectorTurnTenant(ORG), origin), origin)

	it.effect("reads as the linked asker, under the roles they hold now", () =>
		Effect.gen(function* () {
			const tenant: TenantContext = yield* run(asking(ADA)).pipe(
				Effect.provide([
					memberships(() =>
						Effect.succeedSome({ orgId: ORG, role: MEMBER, customPermissions: [] }),
					),
					noActors,
				]),
			)

			assert.strictEqual(tenant.userId, ADA)
			assert.deepStrictEqual(tenant.roles, [MEMBER])
			assert.isUndefined(tenant.actorId)
		}),
	)

	it.effect("refuses a linked asker whose role may not ask Maple AI", () =>
		Effect.gen(function* () {
			const failure = yield* run(asking(ADA)).pipe(
				Effect.provide([
					memberships(() =>
						Effect.succeedSome({
							orgId: ORG,
							role: CUSTOM,
							customPermissions: ["telemetry:read"],
						}),
					),
					noActors,
				]),
				Effect.flip,
			)

			assert.strictEqual(failure.reason, "not_permitted")
			assert.strictEqual(failure.message, Policy.denialFor("ai:ask").message)
		}),
	)

	it.effect("refuses a linked asker who left the organization", () =>
		Effect.gen(function* () {
			const failure = yield* run(asking(ADA)).pipe(
				Effect.provide([memberships(() => Effect.succeedNone), noActors]),
				Effect.flip,
			)

			assert.strictEqual(failure._tag, "@maple/ai/LinkedUserNotPermitted")
			assert.strictEqual(failure.reason, "not_a_member")
		}),
	)

	it.effect("refuses a linked id that does not decode, rather than reading as the connector", () =>
		Effect.gen(function* () {
			const failure = yield* run({ ...APPROVER, actingUserId: "" }).pipe(
				Effect.provide([memberships(die), actorsThat(CONNECTOR_ACTOR)]),
				Effect.flip,
			)

			assert.strictEqual(failure._tag, "@maple/ai/LinkedUserNotPermitted")
		}),
	)

	it.effect("reads as the connector, with no roles, when nobody is named", () =>
		Effect.gen(function* () {
			const tenant: TenantContext = yield* run(asking()).pipe(
				Effect.provide([memberships(die), actorsThat(CONNECTOR_ACTOR)]),
			)

			assert.strictEqual(tenant.userId, CONNECTOR_TENANT_USER_ID)
			assert.deepStrictEqual(tenant.roles, [])
			assert.deepStrictEqual(tenant.permissions, ["telemetry:read"])
			assert.strictEqual(tenant.actorId, CONNECTOR_ACTOR)
		}),
	)

	it("only reads telemetry when nobody is named, even from a host that sent no permissions", () => {
		const { permissions: _sent, ...fromOlderHost } = connectorTurnTenant(ORG)
		assert.deepStrictEqual(toTenantContext(fromOlderHost, asking()).permissions, ["telemetry:read"])
	})
})
