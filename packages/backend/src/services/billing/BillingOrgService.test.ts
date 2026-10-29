import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { seedOrgRow } from "@maple/backend/platform/test-two-orgs"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { AutumnClient, type AutumnResult } from "@maple/backend/services/billing/autumn-http"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { ownBillingCustomer } from "./billing-customer"
import { BillingCustomerResolver } from "./BillingCustomerResolver"
import { BillingOrgService } from "./BillingOrgService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = Schema.decodeUnknownSync(OrgId)
const PAYER = orgId("org_payer")
const MEMBER = orgId("org_member")
const OTHER = orgId("org_other")
const USER = Schema.decodeUnknownSync(UserId)("user_admin")
const ADMIN = [Schema.decodeUnknownSync(RoleName)("org:admin")]
const MEMBER_ROLE = [Schema.decodeUnknownSync(RoleName)("org:member")]

interface World {
	/** Orgs whose Autumn customer holds the `billing_sub_orgs` flag. */
	enabled: Set<string>
	/** The caller's role in each org, as Clerk reports it. */
	roles: Map<string, string>
	/** Orgs served by another region. */
	elsewhere: Set<string>
	/** Each org's own subscriptions, as Autumn returns them. */
	subscriptions: Map<string, ReadonlyArray<Record<string, unknown>>>
	cancelled: Array<{ customerId: string; planId: string; action: string }>
	/** Autumn calls that cancel plans, each one request. */
	cancelCalls: number
	/** Fail every cancel request, the way an Autumn outage would. */
	cancelFails: boolean
	/** Every usage track sent to Autumn: customer, feature, value. */
	tracked: Array<{ customer: string; feature: string; value: number }>
}

const makeWorld = (overrides: Partial<World> = {}): World => ({
	enabled: new Set([PAYER, OTHER]),
	roles: new Map([
		[PAYER, "org:admin"],
		[OTHER, "org:admin"],
		[MEMBER, "org:admin"],
	]),
	elsewhere: new Set(),
	subscriptions: new Map(),
	cancelled: [],
	cancelCalls: 0,
	cancelFails: false,
	tracked: [],
	...overrides,
})

const die = () => Effect.die(new Error("not used by this test"))

const customer = (world: World, id: string): AutumnResult => ({
	statusCode: 200,
	response: {
		id,
		subscriptions: world.subscriptions.get(id) ?? [],
		flags: world.enabled.has(id) ? { billing_sub_orgs: { featureId: "billing_sub_orgs" } } : {},
	},
})

const layerFor = (testDb: TestDb, world: World) =>
	Layer.effect(BillingOrgService, BillingOrgService.make).pipe(
		Layer.provideMerge(BillingCustomerResolver.layer),
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(AutumnClient, {
					getOrCreateCustomer: (customerId) => Effect.sync(() => customer(world, customerId)),
					cancelPlans: (customerId, cancels) =>
						Effect.sync((): AutumnResult => {
							world.cancelCalls += 1
							if (world.cancelFails) return { statusCode: 503, response: { message: "down" } }
							world.cancelled.push(...cancels.map((cancel) => ({ customerId, ...cancel })))
							// Autumn stamps the cancellation, so the next read skips it.
							world.subscriptions.set(
								customerId,
								(world.subscriptions.get(customerId) ?? []).map((sub) =>
									cancels.some((cancel) => cancel.planId === sub.planId)
										? { ...sub, canceledAt: 1 }
										: sub,
								),
							)
							return { statusCode: 200, response: {} }
						}),
					aggregateEvents: die,
					attach: die,
					previewAttach: die,
					openCustomerPortal: die,
					listPlans: die,
					applyReward: die,
					updateCustomerBillingControls: die,
					updateCustomerName: die,
				}),
				Layer.succeed(OrgMembershipService, {
					verify: (_userId, org) =>
						Effect.sync(() => {
							const role = world.roles.get(org)
							return role === undefined
								? Option.none()
								: Option.some({ orgId: org, role: Schema.decodeUnknownSync(RoleName)(role) })
						}),
				}),
				Layer.succeed(OrganizationRegionService, {
					region: "us",
					ensureServedHere: () => Effect.void,
					servedHere: (org) => Effect.succeed(world.elsewhere.has(org) ? "elsewhere" : "here"),
					forget: () => Effect.void,
				}),
				Layer.succeed(OrganizationService, {
					create: die,
					chooseRegion: die,
					delete: die,
					retrieve: (id) =>
						Effect.succeed({
							id,
							name: `Name of ${id}`,
							slug: null,
							imageUrl: null,
							createdAtMs: null,
						}),
				}),
				FetchHttpClient.layer,
			),
		),
		// Autumn's track route, recorded: the uptime monitor transfer goes through it.
		Layer.provideMerge(
			Layer.succeed(FetchHttpClient.Fetch, async (_input, init) => {
				const body = JSON.parse(String(init?.body ?? "{}"))
				world.tracked.push({
					customer: body.customer_id,
					feature: body.feature_id,
					value: body.value,
				})
				return new Response("{}", { status: 200 })
			}),
		),
		Layer.provide(EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))),
		Layer.provide(testDb.layer),
		// Read when a track runs, so it has to reach the test's fiber.
		Layer.provideMerge(
			ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTUMN_SECRET_KEY: "am_sk_test" })),
		),
	)

const run = <A, E>(
	world: World,
	effect: Effect.Effect<A, E, BillingOrgService | BillingCustomerResolver>,
	seed: (testDb: TestDb) => Effect.Effect<void> = () => Effect.void,
) => {
	const testDb = createTestDb(trackedDbs)
	return seed(testDb).pipe(Effect.andThen(effect), Effect.provide(layerFor(testDb, world)))
}

const linkMember = (to = PAYER) =>
	Effect.gen(function* () {
		const service = yield* BillingOrgService
		return yield* service.link({ orgId: MEMBER, userId: USER, roles: ADMIN, billingOrgId: to })
	})

const rejection = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
	Exit.isFailure(exit)
		? Option.match(Exit.findErrorOption(exit), {
				onNone: () => "defect",
				onSome: (error) =>
					"reason" in error && typeof error.reason === "string" ? error.reason : error._tag,
			})
		: "succeeded"

describe("BillingOrgService", () => {
	it.effect("bills a linked org to its billing org, and keeps billing writes with the payer", () =>
		run(
			makeWorld(),
			Effect.gen(function* () {
				const resolver = yield* BillingCustomerResolver
				const service = yield* BillingOrgService
				assert.strictEqual(yield* resolver.customerFor(MEMBER), ownBillingCustomer(MEMBER))

				const linked = yield* linkMember()
				assert.strictEqual(linked.role, "member")
				assert.strictEqual(linked.billingOrg.orgId, PAYER)
				assert.strictEqual(linked.billingOrg.name, "Name of org_payer")

				assert.strictEqual(yield* resolver.customerFor(MEMBER), ownBillingCustomer(PAYER))
				assert.strictEqual(yield* resolver.customerFor(PAYER), ownBillingCustomer(PAYER))
				const write = yield* Effect.exit(resolver.requireOwnBilling(MEMBER))
				assert.strictEqual(rejection(write), "@maple/http/errors/BillingManagedByBillingOrgError")
				assert.strictEqual(yield* resolver.requireOwnBilling(PAYER), ownBillingCustomer(PAYER))

				const payer = yield* service.account(PAYER)
				assert.strictEqual(payer.role, "billing_org")
				assert.deepStrictEqual(
					payer.members.map((member) => member.orgId),
					[MEMBER],
				)
				assert.isNumber(payer.members[0]?.linkedAt)
			}),
		),
	)

	it.effect("reads an unlinked org as standalone", () =>
		run(
			makeWorld(),
			Effect.gen(function* () {
				const account = yield* (yield* BillingOrgService).account(OTHER)
				assert.strictEqual(account.role, "standalone")
				assert.strictEqual(account.billingOrg.orgId, OTHER)
				assert.deepStrictEqual(account.members, [])
			}),
		),
	)

	it.effect("cancels the linked org's own plans in one request, once", () => {
		const world = makeWorld({
			subscriptions: new Map([
				[
					MEMBER,
					[
						{ planId: "startup", status: "active" },
						{ planId: "openrouter_byok", status: "active", addOn: true },
						{ planId: "old", status: "active", canceledAt: 1 },
						// A downgrade the org scheduled before linking would start on its own card.
						{ planId: "hobby", status: "scheduled" },
						{ planId: "older", status: "expired" },
						{ planId: "free", status: "active", autoEnable: true },
					],
				],
			]),
		})
		return run(
			world,
			Effect.gen(function* () {
				yield* linkMember()
				// The same link again is a no-op, not a second round of cancellations.
				yield* linkMember()
				assert.deepStrictEqual(world.cancelled, [
					{ customerId: MEMBER, planId: "startup", action: "cancel_end_of_cycle" },
					{ customerId: MEMBER, planId: "openrouter_byok", action: "cancel_end_of_cycle" },
					{ customerId: MEMBER, planId: "hobby", action: "cancel_immediately" },
				])
				assert.strictEqual(world.cancelCalls, 1)
			}),
		)
	})

	it.effect("leaves no link behind when the cancel fails, and a retry finishes it", () => {
		const world = makeWorld({
			cancelFails: true,
			subscriptions: new Map([[MEMBER, [{ planId: "startup", status: "active" }]]]),
		})
		return run(
			world,
			Effect.gen(function* () {
				const resolver = yield* BillingCustomerResolver
				const failed = yield* Effect.exit(linkMember())
				assert.isTrue(Exit.isFailure(failed))
				assert.isTrue(Option.isNone(yield* resolver.readLink(MEMBER)))
				// No link, so the member's monitors never left it.
				assert.deepStrictEqual(world.tracked, [])

				world.cancelFails = false
				assert.strictEqual((yield* linkMember()).role, "member")
				assert.deepStrictEqual(world.cancelled, [
					{ customerId: MEMBER, planId: "startup", action: "cancel_end_of_cycle" },
				])
			}),
			(testDb) => seedOrgRow(testDb, "uptime_monitors", "org_id", MEMBER).pipe(Effect.orDie),
		)
	})

	it.effect("serialises concurrent links: one cancel, one link, one monitor move", () => {
		const world = makeWorld({
			subscriptions: new Map([[MEMBER, [{ planId: "startup", status: "active" }]]]),
		})
		return run(
			world,
			Effect.gen(function* () {
				const results = yield* Effect.all([linkMember(), linkMember()], { concurrency: 2 })
				assert.deepStrictEqual(
					results.map((account) => account.role),
					["member", "member"],
				)
				assert.strictEqual(world.cancelCalls, 1)
				const service = yield* BillingOrgService
				assert.deepStrictEqual(
					(yield* service.members(PAYER)).map((row) => row.orgId),
					[MEMBER],
				)
			}),
		)
	})

	it.effect("moves the member's monitors to the payer on link and back on unlink, once each", () => {
		const world = makeWorld()
		return run(
			world,
			Effect.gen(function* () {
				const service = yield* BillingOrgService
				yield* linkMember()
				yield* linkMember()
				yield* service.unlink({ orgId: MEMBER, roles: ADMIN, memberOrgId: MEMBER })
				const monitorMoves = world.tracked.filter((track) => track.feature === "uptime_monitors")
				assert.deepStrictEqual(monitorMoves, [
					{ customer: MEMBER, feature: "uptime_monitors", value: -2 },
					{ customer: PAYER, feature: "uptime_monitors", value: 2 },
					// The retried link sends the same keyed moves again; Autumn drops the repeats.
					{ customer: MEMBER, feature: "uptime_monitors", value: -2 },
					{ customer: PAYER, feature: "uptime_monitors", value: 2 },
					{ customer: PAYER, feature: "uptime_monitors", value: -2 },
					{ customer: MEMBER, feature: "uptime_monitors", value: 2 },
				])
			}),
			(testDb) =>
				Effect.all(
					[
						seedOrgRow(testDb, "uptime_monitors", "org_id", MEMBER),
						seedOrgRow(testDb, "uptime_monitors", "org_id", MEMBER),
					],
					{ discard: true },
				).pipe(Effect.orDie),
		)
	})

	it.effect("refuses links the rules forbid", () =>
		Effect.gen(function* () {
			const attempt = (
				world: World,
				input: { orgId: OrgId; billingOrgId: OrgId; roles?: typeof ADMIN },
			) =>
				run(
					world,
					Effect.gen(function* () {
						const service = yield* BillingOrgService
						return yield* service.link({ userId: USER, roles: ADMIN, ...input })
					}),
				).pipe(Effect.exit, Effect.map(rejection))

			assert.strictEqual(
				yield* attempt(makeWorld(), { orgId: MEMBER, billingOrgId: MEMBER }),
				"same_org",
			)
			assert.strictEqual(
				yield* attempt(makeWorld({ roles: new Map([[PAYER, "org:member"]]) }), {
					orgId: MEMBER,
					billingOrgId: PAYER,
				}),
				"not_admin_of_billing_org",
			)
			assert.strictEqual(
				yield* attempt(makeWorld({ roles: new Map() }), { orgId: MEMBER, billingOrgId: PAYER }),
				"not_admin_of_billing_org",
			)
			assert.strictEqual(
				yield* attempt(makeWorld({ enabled: new Set() }), { orgId: MEMBER, billingOrgId: PAYER }),
				"not_enabled",
			)
			assert.strictEqual(
				yield* attempt(makeWorld({ elsewhere: new Set([PAYER]) }), {
					orgId: MEMBER,
					billingOrgId: PAYER,
				}),
				"region_mismatch",
			)
			assert.strictEqual(
				yield* attempt(makeWorld(), { orgId: MEMBER, billingOrgId: PAYER, roles: MEMBER_ROLE }),
				"@maple/http/errors/BillingForbiddenError",
			)
		}),
	)

	it.effect("keeps billing one level deep", () =>
		run(
			makeWorld(),
			Effect.gen(function* () {
				const service = yield* BillingOrgService
				yield* linkMember()
				// A member cannot pay for others, a payer cannot be billed elsewhere, and a member
				// cannot move to a second payer without leaving the first.
				const throughMember = yield* Effect.exit(
					service.link({ orgId: OTHER, userId: USER, roles: ADMIN, billingOrgId: MEMBER }),
				)
				assert.strictEqual(rejection(throughMember), "billing_org_is_member")
				const payerElsewhere = yield* Effect.exit(
					service.link({ orgId: PAYER, userId: USER, roles: ADMIN, billingOrgId: OTHER }),
				)
				assert.strictEqual(rejection(payerElsewhere), "org_is_billing_org")
				assert.strictEqual(rejection(yield* Effect.exit(linkMember(OTHER))), "already_linked")
			}),
		),
	)

	it.effect("lets the member leave or the payer let it go, and nobody else", () =>
		run(
			makeWorld(),
			Effect.gen(function* () {
				const resolver = yield* BillingCustomerResolver
				const service = yield* BillingOrgService
				yield* linkMember()

				const stranger = yield* Effect.exit(
					service.unlink({ orgId: OTHER, roles: ADMIN, memberOrgId: MEMBER }),
				)
				assert.strictEqual(rejection(stranger), "not_a_member")
				const nonAdmin = yield* Effect.exit(
					service.unlink({ orgId: PAYER, roles: MEMBER_ROLE, memberOrgId: MEMBER }),
				)
				assert.strictEqual(rejection(nonAdmin), "@maple/http/errors/BillingForbiddenError")

				const payer = yield* service.unlink({ orgId: PAYER, roles: ADMIN, memberOrgId: MEMBER })
				assert.strictEqual(payer.role, "standalone")
				assert.strictEqual(yield* resolver.customerFor(MEMBER), ownBillingCustomer(MEMBER))

				yield* linkMember()
				const left = yield* service.unlink({ orgId: MEMBER, roles: ADMIN, memberOrgId: MEMBER })
				assert.strictEqual(left.role, "standalone")
				assert.strictEqual(yield* resolver.customerFor(MEMBER), ownBillingCustomer(MEMBER))
			}),
		),
	)
})
