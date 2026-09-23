/**
 * The chat-identity queries, against a real database.
 *
 * One row here is standing authority to change an org's data as a particular Maple user, so the
 * properties worth pinning are the ones that decide WHOSE authority a click carries: the lookup is
 * scoped to an org, re-linking moves a binding rather than adding a second, and leaving an org
 * takes every link with it.
 */
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { ChatConnectorId, ChatIdentityId, OrgId, UserId } from "@maple/domain/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	forgetChatIdentitiesForMember,
	linkChatIdentity,
	listChatIdentities,
	resolveChatIdentity,
	unlinkChatIdentity,
} from "./chat-identity-rows"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeSync(OrgId)("org_1")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_2")
const TESTCHAT = Schema.decodeSync(ChatConnectorId)("testchat")
const ADA = Schema.decodeSync(UserId)("user_ada")
const BEN = Schema.decodeSync(UserId)("user_ben")
const EXTERNAL = "platform-user-1"

let minted = 0
const newId = () =>
	Schema.decodeSync(ChatIdentityId)(`00000000-0000-4000-8000-${String(++minted).padStart(12, "0")}`)

const link = (orgId: OrgId, userId: UserId, externalUserId = EXTERNAL, displayName?: string) =>
	Effect.flatMap(Database, (database) =>
		linkChatIdentity(database, {
			id: newId(),
			orgId,
			connectorId: TESTCHAT,
			externalUserId,
			userId,
			...(displayName === undefined ? undefined : { displayName }),
			nowMs: 1_700_000_000_000,
		}),
	)

const resolve = (orgId: OrgId, externalUserId = EXTERNAL) =>
	Effect.flatMap(Database, (database) => resolveChatIdentity(database, orgId, TESTCHAT, externalUserId))

const withDb = <A, E>(effect: Effect.Effect<A, E, Database>) =>
	effect.pipe(Effect.provide(createTestDb(createdDbs).layer))

describe("resolving a chat identity", () => {
	it.effect("answers the Maple user a chat account speaks for", () =>
		withDb(
			Effect.gen(function* () {
				yield* link(ORG, ADA)

				const found = yield* resolve(ORG)

				assert.strictEqual(Option.getOrUndefined(found)?.userId, ADA)
				assert.strictEqual(Option.getOrUndefined(found)?.externalUserId, EXTERNAL)
			}),
		),
	)

	it.effect("is nothing for an account nobody linked", () =>
		withDb(
			Effect.gen(function* () {
				assert.isTrue(Option.isNone(yield* resolve(ORG, "never-linked")))
			}),
		),
	)

	it.effect("never answers with another organization's link", () =>
		withDb(
			Effect.gen(function* () {
				// The same person, on the same platform, in two Maple orgs. A row minted for one
				// must not speak for the other — this is the whole reason the binding is per org.
				yield* link(ORG, ADA)

				assert.isTrue(Option.isNone(yield* resolve(OTHER_ORG)))
			}),
		),
	)
})

describe("linking", () => {
	it.effect("moves a binding rather than leaving two, when somebody links again", () =>
		withDb(
			Effect.gen(function* () {
				yield* link(ORG, ADA)
				yield* link(ORG, BEN)

				// Somebody who links again from a different Maple account means to move it.
				assert.strictEqual(Option.getOrUndefined(yield* resolve(ORG))?.userId, BEN)
				const database = yield* Database
				assert.lengthOf(yield* listChatIdentities(database, ORG, ADA), 0)
				assert.lengthOf(yield* listChatIdentities(database, ORG, BEN), 1)
			}),
		),
	)

	it.effect("remembers what the platform showed, and forgets it when unset", () =>
		withDb(
			Effect.gen(function* () {
				// The card has nothing but this row, so it stores the name — but display only: a
				// platform that reports none is a null, never a failure.
				yield* link(ORG, ADA, EXTERNAL, "Ada L.")
				assert.strictEqual(Option.getOrUndefined(yield* resolve(ORG))?.displayName, "Ada L.")

				yield* link(ORG, ADA)
				assert.isNull(Option.getOrUndefined(yield* resolve(ORG))?.displayName ?? null)
			}),
		),
	)

	it.effect("keeps one person's two chat accounts apart", () =>
		withDb(
			Effect.gen(function* () {
				yield* link(ORG, ADA, "account-a")
				yield* link(ORG, ADA, "account-b")

				const database = yield* Database
				assert.lengthOf(yield* listChatIdentities(database, ORG, ADA), 2)
			}),
		),
	)
})

describe("unlinking", () => {
	it.effect("drops the caller's own link and says it did", () =>
		withDb(
			Effect.gen(function* () {
				yield* link(ORG, ADA)
				const database = yield* Database

				assert.isTrue(yield* unlinkChatIdentity(database, ORG, TESTCHAT, ADA))
				assert.isTrue(Option.isNone(yield* resolve(ORG)))
				// Nothing to drop the second time.
				assert.isFalse(yield* unlinkChatIdentity(database, ORG, TESTCHAT, ADA))
			}),
		),
	)

	it.effect("takes every link a member held when they leave the org", () =>
		withDb(
			Effect.gen(function* () {
				yield* link(ORG, ADA, "account-a")
				yield* link(ORG, ADA, "account-b")
				yield* link(ORG, BEN, "account-c")
				yield* link(OTHER_ORG, ADA, "account-a")
				const database = yield* Database

				assert.strictEqual(yield* forgetChatIdentitiesForMember(database, ORG, ADA), 2)

				// Theirs in this org are gone; somebody else's and their own elsewhere are not.
				assert.isTrue(Option.isNone(yield* resolve(ORG, "account-a")))
				assert.isTrue(Option.isSome(yield* resolve(ORG, "account-c")))
				assert.isTrue(Option.isSome(yield* resolve(OTHER_ORG, "account-a")))
			}),
		),
	)
})
