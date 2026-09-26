import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/http"
import { supportChannelName } from "@maple/domain/support-channel"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { SupportChannelService } from "./SupportChannelService"
import { SupportSlackClient, SupportSlackRefusedError, type SupportSlackMethod } from "./SupportSlackClient"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_support")
const USER = Schema.decodeUnknownSync(UserId)("user_support")
const tenant: TenantContext = { orgId: ORG, userId: USER, roles: [], authMode: "clerk" }

const die = () => Effect.die(new Error("not exercised by this test"))

interface World {
	configured: boolean
	inviteFails: boolean
	takenNames: Set<string>
	calls: Array<{ method: SupportSlackMethod; body: Record<string, unknown> }>
}

const freshWorld = (): World => ({ configured: true, inviteFails: false, takenNames: new Set(), calls: [] })

const stubs = (world: World) =>
	Layer.mergeAll(
		Layer.succeed(SupportSlackClient, {
			get configured() {
				return world.configured
			},
			teamUserIds: ["U_MAPLE"],
			call: (method, body) =>
				Effect.suspend(() => {
					world.calls.push({ method, body })
					if (method === "conversations.create") {
						const name = String(body.name)
						if (world.takenNames.has(name)) {
							return Effect.fail(
								new SupportSlackRefusedError({
									message: "taken",
									method,
									error: "name_taken",
								}),
							)
						}
						world.takenNames.add(name)
						return Effect.succeed({ ok: true, channel: { id: `C_${name}`, name } })
					}
					if (method === "conversations.inviteShared" && world.inviteFails) {
						return Effect.fail(
							new SupportSlackRefusedError({
								message: "refused",
								method,
								error: "ratelimited",
							}),
						)
					}
					return Effect.succeed({ ok: true })
				}),
		}),
		Layer.succeed(OrgMembersService, {
			listMembers: die,
			resolveMembers: (_orgId, userIds) =>
				Effect.succeed(
					userIds.map((userId) => ({
						userId,
						email: `${userId}@acme.com`,
						name: null,
						imageUrl: null,
					})),
				),
		}),
		Layer.succeed(OrganizationService, {
			create: die,
			chooseRegion: die,
			retrieve: (orgId) =>
				Effect.succeed({
					id: orgId,
					name: "Acme Inc.",
					slug: "acme",
					imageUrl: null,
					createdAtMs: 0,
				}),
			delete: die,
		}),
	)

const makeLayer = (world: World, testDb: TestDb) =>
	Layer.effect(SupportChannelService, SupportChannelService.make).pipe(
		Layer.provide(Layer.mergeAll(stubs(world), testDb.layer)),
	)

const methods = (world: World) => world.calls.map((call) => call.method)

/** What the route does: ensure, then invite. */
const invite = (tenant: TenantContext) =>
	Effect.gen(function* () {
		const service = yield* SupportChannelService
		const result = yield* service.ensureForCaller(tenant)
		yield* service.sendInvite(result.channel, result.email)
		return result
	})

describe("supportChannelName", () => {
	it("slugs the org name into Slack's alphabet", () => {
		assert.strictEqual(supportChannelName("Acme Inc.", "org_1"), "maple-acme-inc")
		assert.strictEqual(supportChannelName("Café  Ünïcode!", "org_1"), "maple-cafe-unicode")
	})

	it("falls back to the org id and suffixes retries", () => {
		assert.strictEqual(supportChannelName("日本", "org_ABC"), "maple-org_abc")
		assert.strictEqual(supportChannelName("Acme", "org_1", 2), "maple-acme-3")
	})

	it("stays within Slack's 80 characters", () => {
		assert.isAtMost(supportChannelName("a".repeat(200), "org_1", 3).length, 80)
	})
})

describe("SupportChannelService", () => {
	it.effect("creates the channel once, then only sends invites", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* SupportChannelService
			assert.deepStrictEqual(yield* service.retrieve(ORG), { status: "not_created" })

			const first = yield* invite(tenant)
			assert.isTrue(first.created)
			assert.strictEqual(first.channel.channelName, "maple-acme-inc")
			assert.strictEqual(first.email, "user_support@acme.com")
			assert.deepStrictEqual(methods(world), [
				"conversations.create",
				"conversations.invite",
				"chat.postMessage",
				"conversations.inviteShared",
			])

			world.calls = []
			const second = yield* invite(tenant)
			assert.isFalse(second.created)
			assert.strictEqual(second.channel.channelId, first.channel.channelId)
			assert.deepStrictEqual(methods(world), ["conversations.inviteShared"])

			const view = yield* service.retrieve(ORG)
			assert.strictEqual(view.status, "active")
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("keeps the channel it created when the invite that follows fails", () => {
		const world = freshWorld()
		world.inviteFails = true
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* SupportChannelService
			const first = yield* service.ensureForCaller(tenant)
			assert.isTrue(first.created)
			const failed = yield* Effect.flip(service.sendInvite(first.channel, first.email))
			assert.strictEqual(failed._tag, "@maple/http/errors/SupportChannelUnavailableError")

			world.inviteFails = false
			world.calls = []
			const retry = yield* invite(tenant)
			assert.isFalse(retry.created)
			assert.strictEqual(retry.channel.channelId, first.channel.channelId)
			assert.deepStrictEqual(methods(world), ["conversations.inviteShared"])
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("steps past a channel name that is already taken", () => {
		const world = freshWorld()
		world.takenNames.add("maple-acme-inc")
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const result = yield* invite(tenant)
			assert.strictEqual(result.channel.channelName, "maple-acme-inc-2")
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("reports unavailable and refuses to invite without a bot token", () => {
		const world = freshWorld()
		world.configured = false
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* SupportChannelService
			assert.deepStrictEqual(yield* service.retrieve(ORG), { status: "unavailable" })
			const exit = yield* Effect.exit(invite(tenant))
			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(world.calls.length, 0)
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("answers busy while another request holds a live reservation", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO org_support_channels (org_id, reserved_at, created_by_user_id, created_at, updated_at)
					 VALUES ($1, now(), 'user_other', now(), now())`,
					[ORG],
				),
			)
			const error = yield* Effect.flip(invite(tenant))
			assert.strictEqual(error._tag, "@maple/http/errors/SupportChannelBusyError")
			assert.isFalse(methods(world).includes("conversations.create"))
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})
})
