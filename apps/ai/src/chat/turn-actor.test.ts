/**
 * Who a turn acts as.
 *
 * The tenant a connector turn arrives with carries a placeholder user id that no user row stands
 * behind, so the turn resolves the connector's own agent actor before it runs anything. Everything
 * that asks "who did this" — the audit log, an issue claim, a comment — reads that pin.
 */
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import { ErrorPersistenceError } from "@maple/domain/http"
import { OrgId, UserId } from "@maple/domain/primitives"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { withConnectorActor } from "./turn-runner"

const ORG = Schema.decodeUnknownSync(OrgId)("org_turn_actor_test")
const PLACEHOLDER_USER = Schema.decodeUnknownSync(UserId)("chat-connector")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = () => ErrorActorsService.layer.pipe(Layer.provide(createTestDb(createdDbs).layer))

const CONNECTOR_ORIGIN: ChatTurnOrigin = {
	kind: "connector",
	connectorId: "testchat",
	workspaceId: "w1",
	externalUserId: "u-1",
	displayName: "Ada",
}

const tenant: TenantContext = {
	orgId: ORG,
	userId: PLACEHOLDER_USER,
	roles: [],
	authMode: "self_hosted",
	turnOrigin: CONNECTOR_ORIGIN,
}

const die = () => Effect.die("not reached in this test")

/** A database that cannot answer: the turn still has to run. */
const unavailableActors = Layer.succeed(ErrorActorsService, {
	registerAgent: die,
	listAgents: die,
	lookupActor: die,
	ensureUserActor: die,
	actorExists: die,
	ensureSystemActor: die,
	ensureAgentActor: () => Effect.fail(new ErrorPersistenceError({ message: "actors table unavailable" })),
	touchActor: die,
	collectActorDocs: die,
})

describe("withConnectorActor", () => {
	it.effect("pins one agent actor per org and connector, reused across turns", () =>
		Effect.gen(function* () {
			const first = yield* withConnectorActor(tenant, CONNECTOR_ORIGIN)
			const second = yield* withConnectorActor(tenant, CONNECTOR_ORIGIN)
			assert.isDefined(first.actorId)
			assert.strictEqual(first.actorId, second.actorId)

			const actors = yield* ErrorActorsService
			const doc = yield* actors.lookupActor(ORG, first.actorId!)
			assert.strictEqual(doc.type, "agent")
			assert.strictEqual(doc.agentName, "chat-connector-testchat")
			// No Maple user is behind a connector turn, so none is recorded as one.
			assert.strictEqual(doc.userId, null)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("answers the turn unpinned when the actor row cannot be read", () =>
		Effect.gen(function* () {
			const resolved = yield* withConnectorActor(tenant, CONNECTOR_ORIGIN)
			// No actor, but the entry still names the connector: the origin rides on the tenant.
			assert.isUndefined(resolved.actorId)
			assert.strictEqual(resolved.turnOrigin, CONNECTOR_ORIGIN)
		}).pipe(Effect.provide(unavailableActors)),
	)

	it.effect("leaves an app turn and an unattended pass unpinned", () =>
		Effect.gen(function* () {
			const app = yield* withConnectorActor(tenant, { kind: "app" })
			const autonomous = yield* withConnectorActor(tenant, { kind: "autonomous" })
			assert.isUndefined(app.actorId)
			assert.isUndefined(autonomous.actorId)
		}).pipe(Effect.provide(makeLayer())),
	)
})
