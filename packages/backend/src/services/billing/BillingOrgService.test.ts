import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
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
	cancelled: Array<{ customerId: string; planId: string }>
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
					cancelAtPeriodEnd: (customerId, { planId }) =>
						Effect.sync(() => {
							world.cancelled.push({ customerId, planId })
							// Autumn stamps the cancellation, so the next read skips it.
							world.subscriptions.set(
								customerId,
								(world.subscriptions.get(customerId) ?? []).map((sub) =>
									sub.planId === planId ? { ...sub, canceledAt: 1 } : sub,
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
		Layer.provide(EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))),
		Layer.provide(testDb.layer),
		// No Autumn key: the uptime monitor transfer tracks nothing.
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
	)

const run = <A, E>(
	world: World,
	effect: Effect.Effect<A, E, BillingOrgService | BillingCustomerResolver>,
) => {
	const testDb = createTestDb(trackedDbs)
	return effect.pipe(Effect.provide(layerFor(testDb, world)))
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

	it.effect("cancels the linked org's own running plans at period end, once", () => {
		const world = makeWorld({
			subscriptions: new Map([
				[
					MEMBER,
					[
						{ planId: "startup", status: "active" },
						{ planId: "openrouter_byok", status: "active", addOn: true },
						{ planId: "old", status: "active", canceledAt: 1 },
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
					{ customerId: MEMBER, planId: "startup" },
					{ customerId: MEMBER, planId: "openrouter_byok" },
				])
			}),
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
