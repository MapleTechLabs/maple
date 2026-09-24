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
import { ActorId, OrgId, UserId } from "@maple/domain/primitives"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { withConnectorActor } from "./turn-actor"

const ORG = Schema.decodeUnknownSync(OrgId)("org_turn_actor_test")
const PLACEHOLDER_USER = Schema.decodeUnknownSync(UserId)("chat-connector")
const PINNED_ACTOR = Schema.decodeUnknownSync(ActorId)("00000000-0000-4000-8000-00000000beef")
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

			// A second connector in the same org is a second identity, which is why the
			// name is derived from the connector rather than fixed.
			const other = yield* withConnectorActor(tenant, { ...CONNECTOR_ORIGIN, connectorId: "otherchat" })
			assert.notStrictEqual(other.actorId, first.actorId)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("answers the turn unpinned when the actor row cannot be read", () =>
		Effect.gen(function* () {
			const resolved = yield* withConnectorActor(tenant, CONNECTOR_ORIGIN)
			// No actor, but the turn ran: the entry still names the connector from its origin.
			assert.isUndefined(resolved.actorId)
		}).pipe(Effect.provide(unavailableActors)),
	)

	it.effect("mints nothing for an app turn or an unattended pass, and keeps their own actor", () =>
		Effect.gen(function* () {
			const pinned = { ...tenant, actorId: PINNED_ACTOR }
			assert.strictEqual((yield* withConnectorActor(pinned, { kind: "app" })).actorId, PINNED_ACTOR)
			assert.strictEqual(
				(yield* withConnectorActor(pinned, { kind: "autonomous" })).actorId,
				PINNED_ACTOR,
			)
			assert.isUndefined((yield* withConnectorActor(tenant, { kind: "app" })).actorId)

			const actors = yield* ErrorActorsService
			const agents = yield* actors.listAgents(ORG)
			assert.strictEqual(agents.actors.length, 0)
		}).pipe(Effect.provide(makeLayer())),
	)
})
