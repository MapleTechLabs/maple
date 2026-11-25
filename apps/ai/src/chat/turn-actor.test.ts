/**
 * Who a turn acts as.
 *
 * The tenant a connector turn arrives with carries a placeholder user id that no user row stands
 * behind, so the turn resolves the connector's own agent actor before it runs anything. Everything
 * that asks "who did this" — the audit log, an issue claim, a comment — reads that pin.
 */
import { afterEach, assert, describe, it } from "@effect/vitest"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Effect, Layer, Schema } from "effect"
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import { ErrorPersistenceError, type TenantContext } from "@maple/domain/http"
import { ActorId, OrgId, UserId } from "@maple/primitives"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { AuthorizationUnavailableError } from "@maple/domain/http"
import { RoleName } from "@maple/primitives"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { Logger, Option } from "effect"
import { turnStarterOf, turnTenant, withConnectorActor } from "./turn-actor"

const ORG = Schema.decodeSync(OrgId)("org_turn_actor_test")
const PLACEHOLDER_USER = Schema.decodeSync(UserId)("chat-connector")
const PINNED_ACTOR = Schema.decodeSync(ActorId)("00000000-0000-4000-8000-00000000beef")
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
	permissions: Policy.grantsOf([]),
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
	findOwnedAgentActor: die,
})

describe("withConnectorActor", () => {
	it.effect("pins one agent actor per org and connector, reused across turns", () =>
		Effect.gen(function* () {
			const first = yield* withConnectorActor(tenant, CONNECTOR_ORIGIN)
			const second = yield* withConnectorActor(tenant, CONNECTOR_ORIGIN)
			assert.isDefined(first.actorId)
			assert.strictEqual(first.actorId, second.actorId)

			const actors = yield* ErrorActorsService
			const doc = yield* actors.lookupActor(ORG, first.actorId)
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

const role = Schema.decodeSync(RoleName)
const STARTER = Schema.decodeSync(UserId)("user_starter")

/** A directory where the starter holds the role `now`, has left (`gone`) or cannot be read (`unavailable`). */
const memberships = (now: string, directory: "clerk" | "none" = "clerk", custom: Policy.Grants = []) =>
	Layer.mock(OrgMembershipService)({
		directory,
		verify: (_userId, orgId) =>
			now === "unavailable"
				? Effect.fail(new AuthorizationUnavailableError({ message: "directory down" }))
				: Effect.succeed(
						now === "gone"
							? Option.none()
							: Option.some({ orgId, role: role(now), customPermissions: custom }),
					),
	})

/** A person answering for a pass, holding `permissions`. */
const person = (roles: ReadonlyArray<string>, permissions: Policy.Grants) =>
	({ kind: "person", roles: Arr.map(roles, (name) => role(name)), permissions }) as const

/** Who answers when nobody can be named or confirmed: a person holding nothing. */
const NOBODY = { kind: "person", roles: [], permissions: [] } as const

const startedBy = (
	roles: ReadonlyArray<string>,
	named: "named" | "unnamed" = "named",
	scopes: "reads data sources" | "cannot read data sources" = "reads data sources",
) =>
	({
		kind: "autonomous",
		startedBy: {
			kind: "person",
			...(named === "named" ? { userId: STARTER } : undefined),
			roles,
			mayReadDataSources: scopes === "reads data sources",
		},
	}) satisfies ChatTurnOrigin

describe("turnStarterOf", () => {
	it.effect("answers for a producer's pass as the producer, without reading any membership", () =>
		Effect.gen(function* () {
			const starter = yield* turnStarterOf(ORG, {
				kind: "autonomous",
				startedBy: { kind: "producer", producer: "incident_triage" },
			})
			assert.deepStrictEqual(starter, { kind: "producer" })
		}).pipe(Effect.provide(memberships("unavailable"))),
	)

	it.effect("gives a person what they hold now, not what they started with", () =>
		Effect.gen(function* () {
			const demoted = yield* turnStarterOf(ORG, startedBy(["org:admin"]))
			assert.deepStrictEqual(demoted, person(["org:member"], Policy.grantsOf(["org:member"])))
		}).pipe(Effect.provide(memberships("org:member"))),
	)

	it.effect("keeps a credential that was held below its owner's role where it was", () =>
		Effect.gen(function* () {
			const pinned = yield* turnStarterOf(ORG, startedBy(["org:member"]))
			assert.deepStrictEqual(pinned, person(["org:admin"], Policy.grantsOf(["org:member"])))
		}).pipe(Effect.provide(memberships("org:admin"))),
	)

	it.effect("holds only what a custom role holds now and the credential held when it started", () =>
		Effect.gen(function* () {
			const starter = yield* turnStarterOf(ORG, {
				kind: "autonomous",
				startedBy: {
					kind: "person",
					userId: STARTER,
					roles: ["org:custom"],
					permissions: ["telemetry:read", "data_sources:query", "alerts:manage"],
					mayReadDataSources: true,
				},
			})
			assert.deepStrictEqual(starter, person(["org:custom"], ["telemetry:read", "data_sources:query"]))
		}).pipe(Effect.provide(memberships("org:custom", "clerk", ["telemetry:read", "data_sources:query"]))),
	)

	it.effect("answers as a person holding nothing when nobody is recorded, named or still a member", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* turnStarterOf(ORG, { kind: "autonomous" }), NOBODY)
			assert.deepStrictEqual(yield* turnStarterOf(ORG, startedBy(["org:admin"], "unnamed")), NOBODY)
		}).pipe(Effect.provide(memberships("org:admin"))),
	)

	it.effect("answers as a person holding nothing when the starter left or cannot be looked up", () =>
		Effect.gen(function* () {
			const left = yield* turnStarterOf(ORG, startedBy(["org:admin"])).pipe(
				Effect.provide(memberships("gone")),
			)
			const unreadable = yield* turnStarterOf(ORG, startedBy(["org:admin"])).pipe(
				Effect.provide(memberships("unavailable")),
			)
			assert.deepStrictEqual([left, unreadable], [NOBODY, NOBODY])
		}),
	)
})

describe("turnStarterOf and what the starter's credential could reach", () => {
	it.effect("answers as nobody for a credential whose scopes did not reach data sources", () =>
		Effect.gen(function* () {
			const scoped = yield* turnStarterOf(
				ORG,
				startedBy(["org:engineer"], "named", "cannot read data sources"),
			)
			// A start recorded before the flag existed carries none, and reads the same.
			const unrecorded = yield* turnStarterOf(ORG, {
				kind: "autonomous",
				startedBy: { kind: "person", userId: STARTER, roles: ["org:engineer"] },
			})
			assert.deepStrictEqual([scoped, unrecorded], [NOBODY, NOBODY])
		}).pipe(Effect.provide(memberships("org:engineer"))),
	)
})

describe("turnStarterOf on a deployment with no membership directory", () => {
	const captured = () => {
		const warnings: Array<string> = []
		const layer = Logger.layer([
			Logger.make(({ message, logLevel }) => {
				if (logLevel === "Warn") warnings.push(String(message))
			}),
		])
		return { warnings, layer }
	}

	it.effect("takes what the credential held as it is, and warns about nothing", () => {
		const logs = captured()
		return Effect.gen(function* () {
			const starter = yield* turnStarterOf(ORG, startedBy(["org:engineer"]))
			const unnamed = yield* turnStarterOf(ORG, startedBy(["org:admin"], "unnamed"))
			assert.deepStrictEqual(
				[starter, unnamed],
				[
					person(["org:engineer"], Policy.grantsOf(["org:engineer"])),
					person(["org:admin"], Policy.grantsOf(["org:admin"])),
				],
			)
			assert.deepStrictEqual(logs.warnings, [])
		}).pipe(Effect.provide(Layer.merge(memberships("unavailable", "none"), logs.layer)))
	})

	it.effect("still holds the scope flag there", () =>
		Effect.gen(function* () {
			const scoped = yield* turnStarterOf(
				ORG,
				startedBy(["org:engineer"], "named", "cannot read data sources"),
			)
			assert.deepStrictEqual(scoped, NOBODY)
		}).pipe(Effect.provide(memberships("unavailable", "none"))),
	)

	it.effect("answers as nobody, with a warning, when a directory exists and the lookup fails", () => {
		const logs = captured()
		return Effect.gen(function* () {
			const starter = yield* turnStarterOf(ORG, startedBy(["org:engineer"]))
			assert.deepStrictEqual(starter, NOBODY)
			assert.lengthOf(logs.warnings, 1)
		}).pipe(Effect.provide(Layer.merge(memberships("unavailable", "clerk"), logs.layer)))
	})
})

describe("turnTenant for an unattended pass", () => {
	it.effect("carries who answers for it, and leaves the pass's own identity alone", () =>
		Effect.gen(function* () {
			const pass: TenantContext = { ...tenant, turnOrigin: startedBy(["org:engineer"]) }
			const resolved = yield* turnTenant(pass, startedBy(["org:engineer"]))
			assert.deepStrictEqual(
				resolved.turnStarter,
				person(["org:engineer"], Policy.grantsOf(["org:engineer"])),
			)
			assert.deepStrictEqual([resolved.userId, resolved.roles], [pass.userId, []])
		}).pipe(Effect.provide(Layer.merge(memberships("org:engineer"), unavailableActors))),
	)
})
