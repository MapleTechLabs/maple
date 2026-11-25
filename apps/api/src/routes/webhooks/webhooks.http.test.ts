import * as Policy from "@maple/domain/policy"
import { assert, describe, it } from "@effect/vitest"
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import {
	BillingAccountPersistenceError,
	BillingCustomerId,
	EnterpriseSsoUnavailableError,
	OrgId,
} from "@maple/domain/http"
import { Clock, ConfigProvider, Context, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { HttpRouter } from "effect/http"
import { EnvTestLive } from "@maple/backend/testing/env-test-support"
import { CancellationReviewQueueProducer, QueueSendError } from "@maple/backend/platform/bindings"
import {
	CancellationReviewJob,
	CancellationReviewQueue,
} from "@maple/backend/services/cancellation-review/CancellationReviewQueue"
import {
	ProductEventsService,
	type ProductEventInput,
} from "@maple/backend/services/product-events/ProductEventsService"
import { signSvix } from "@maple/backend/services/product-events/svix"
import { AuditLogService, type AuditLogRecordInput } from "@maple/backend/services/audit/AuditLogService"
import {
	EnterpriseSsoService,
	type DirectoryGroupEvent,
} from "@maple/backend/services/org/enterprise-sso/EnterpriseSsoService"
import {
	MembershipRevocationService,
	MembershipRevocationError,
	type MembershipRevocationSummary,
} from "@maple/backend/services/auth/MembershipRevocationService"
import {
	OrganizationRegionService,
	type HomeAnswer,
} from "@maple/backend/services/org/OrganizationRegionService"
import type { MapleRegion } from "@maple/domain/organization-regions"
import { AutumnWebhookRouter } from "./autumn.http"
import { RolesService } from "@maple/backend/services/roles/RolesService"
import { ClerkWebhookRoute } from "./clerk.http"
import { SVIX_WEBHOOK_MAX_BYTES } from "./svix-receiver"

const CLERK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
const AUTUMN_SECRET = "whsec_" + Buffer.alloc(24, 7).toString("base64")

const makeConfig = (extra: Record<string, string>) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			...extra,
		}),
	)

const recordingProductEvents = () => {
	const tracked: Array<ProductEventInput> = []
	const layer = Layer.succeed(ProductEventsService, {
		enabled: true,
		track: (event) => Effect.sync(() => void tracked.push(event)),
		trackAll: (events) => Effect.sync(() => void tracked.push(...events)),
	})
	return { tracked, layer }
}

const recordingAudit = () => {
	const recorded: Array<AuditLogRecordInput> = []
	const layer = Layer.succeed(AuditLogService, {
		record: (input) => Effect.sync(() => void recorded.push(input)),
		list: () => Effect.succeed([]),
	})
	return { recorded, layer }
}

const EMPTY_SUMMARY: MembershipRevocationSummary = {
	apiKeysRevoked: 0,
	mcpFamiliesRevoked: 0,
	deviceCredentialsRevoked: 0,
	cliAuthorizationsDeleted: 0,
	mcpAuthorizationsDeleted: 0,
	emailDestinationsUpdated: 0,
	mobileDevicesDeleted: 0,
	chatIdentitiesDeleted: 0,
	digestSubscriptionsDisabled: 0,
	dashboardSharesRevoked: 0,
	alertDestinationsDisabled: 0,
}

/** Records the sweeps the route asks for, and can be made to fail on demand. */
const recordingRevocation = (fail = false) => {
	const calls: Array<string> = []
	const run = (label: string) =>
		fail
			? Effect.fail(new MembershipRevocationError({ message: "boom" }))
			: Effect.sync(() => {
					calls.push(label)
					return EMPTY_SUMMARY
				})
	const layer = Layer.succeed(MembershipRevocationService, {
		revokeMembership: (orgId, userId) => run(`revoke:${orgId}:${userId}`),
		revokeUser: (userId) => run(`revokeUser:${userId}`),
		demoteMembership: (orgId, userId, current) =>
			run(`demote:${orgId}:${userId}:${Arr.join(current, ",")}`).pipe(
				Effect.map(() => ({
					apiKeysRevoked: 0,
					mcpFamiliesRevoked: 0,
					deviceCredentialsRevoked: 0,
					dashboardSharesRevoked: 0,
					digestSubscriptionsDisabled: 0,
					mobileDevicesDeleted: 0,
				})),
			),
		invalidateMembership: (userId) =>
			fail
				? Effect.void
				: Effect.sync(() => {
						calls.push(`invalidate:${userId}`)
					}),
	})
	return { calls, layer }
}

/** An instance in `region` that gives one answer about every organization's home. */
const regionsAnswering = (home: HomeAnswer, region: MapleRegion = "us") =>
	Layer.succeed(OrganizationRegionService, {
		region,
		ensureServedHere: () => Effect.void,
		servedHere: () => Effect.succeed(home),
		forget: () => Effect.void,
	})

const decodeQueuedJob = Schema.decodeUnknownSync(CancellationReviewJob)

/** Records the bodies the Autumn route queues for review; the queue can be made to refuse them. */
const recordingCancellationQueue = (fail = false) => {
	const queued: Array<unknown> = []
	const layer = CancellationReviewQueue.layer.pipe(
		Layer.provide(
			Layer.succeed(CancellationReviewQueueProducer, {
				sendBatch: (messages) =>
					fail
						? Effect.fail(new QueueSendError({ message: "queue unavailable", cause: null }))
						: Effect.sync(
								() => void queued.push(...Arr.map(messages, (message) => message.body)),
							),
			}),
		),
	)
	return { queued, layer }
}

/** Records directory-group webhooks; `owns` says whether this region holds the directory. */
const recordingSso = (owns = true) => {
	const applied: Array<DirectoryGroupEvent> = []
	const layer = EnterpriseSsoService.webhookOnly((event) =>
		Effect.sync(() => {
			applied.push(event)
			return owns ? ("applied" as const) : ("not_here" as const)
		}),
	)
	return { applied, layer }
}

/** Every custom role a membership names still matches its definition. */
const matchingRoles = Layer.mock(RolesService)({
	settleMembership: (_orgId, _userId, held) =>
		Effect.succeed(Policy.decodeCustomPermissions(held.permissions)),
})

const makeRouterLayer = (
	router: typeof ClerkWebhookRoute | typeof AutumnWebhookRouter,
	config: Record<string, string>,
	productEvents: Layer.Layer<ProductEventsService>,
	revocation: Layer.Layer<MembershipRevocationService> = recordingRevocation().layer,
	audit: Layer.Layer<AuditLogService> = recordingAudit().layer,
	cancellationQueue: Layer.Layer<CancellationReviewQueue> = recordingCancellationQueue().layer,
	billingCustomers: Layer.Layer<BillingCustomerResolver> = BillingCustomerResolver.standalone,
	regions: Layer.Layer<OrganizationRegionService> = OrganizationRegionService.servesAll,
	sso: Layer.Layer<EnterpriseSsoService> = recordingSso().layer,
) =>
	router.pipe(
		Layer.provide(matchingRoles),
		Layer.provide(sso),
		Layer.provide(productEvents),
		Layer.provide(regions),
		Layer.provide(billingCustomers),
		Layer.provide(cancellationQueue),
		Layer.provide(revocation),
		Layer.provide(audit),
		Layer.provide(EnvTestLive),
		Layer.provide(makeConfig(config)),
	)

const signedHeaders = (secret: string, body: string, nowMs: number, id = "msg_test") =>
	Effect.gen(function* () {
		const timestamp = String(Math.floor(nowMs / 1000))
		const signature = yield* signSvix(secret, id, timestamp, body)
		return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }
	})

const post = (
	handler: (request: Request, context: Context.Context<never>) => Promise<Response>,
	path: string,
	body: BodyInit,
	headers: Record<string, string>,
) =>
	Effect.promise(() =>
		handler(
			new Request(`http://api.localhost${path}`, { method: "POST", body, headers, duplex: "half" }),
			Context.empty(),
		),
	)

/** A body that fails as soon as anything pulls it. */
const unreadableBody = () =>
	new ReadableStream<Uint8Array>({
		pull: (controller) => controller.error(new Error("the body was read")),
	})

const CLERK_USER_CREATED = JSON.stringify({
	type: "user.created",
	timestamp: 1_700_000_000_000,
	data: {
		id: "user_2abc",
		created_at: 1_700_000_000_000,
		primary_email_address_id: "idn_2",
		email_addresses: [
			{ id: "idn_1", email_address: "personal@gmail.com" },
			{ id: "idn_2", email_address: "Dev@Example.COM" },
		],
		external_accounts: [{ provider: "oauth_github" }],
	},
})

const AUTUMN_BILLING_UPDATED = JSON.stringify({
	type: "billing.updated",
	data: {
		object: "billing.updated",
		customer_id: "org_42",
		plan_changes: [
			{
				action: "activated",
				subscription: {
					plan_id: "startup",
					status: "active",
					past_due: false,
					started_at: 1_761_840_000_000,
					canceled_at: null,
					expires_at: null,
					trial_ends_at: null,
					current_period_start: 1_761_840_000_000,
					current_period_end: 1_764_432_000_000,
				},
				previous_attributes: null,
				item_changes: [],
			},
			{
				action: "expired",
				subscription: {
					plan_id: "free",
					status: "expired",
					past_due: false,
					started_at: 1_759_248_000_000,
					canceled_at: 1_761_840_000_000,
					expires_at: 1_761_840_000_000,
					trial_ends_at: null,
					current_period_start: null,
					current_period_end: null,
				},
				previous_attributes: { status: "active" },
				item_changes: [],
			},
		],
		tags: [],
	},
})

const CLERK_MEMBERSHIP_CREATED = JSON.stringify({
	type: "organizationMembership.created",
	timestamp: 1_700_000_000_000,
	data: {
		organization: { id: "org_42" },
		public_user_data: { user_id: "user_2abc" },
		role: "org:admin",
	},
})

describe("ClerkWebhookRouter", () => {
	it.live("refuses unsigned, stale and oversized deliveries before reading the body", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const configured = HttpRouter.toWebHandler(
				makeRouterLayer(ClerkWebhookRoute, { CLERK_WEBHOOK_SECRET: CLERK_SECRET }, events.layer),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const unsigned = yield* post(configured.handler, "/webhooks/clerk", unreadableBody(), {})
				assert.strictEqual(unsigned.status, 401)

				const stale = yield* signedHeaders(CLERK_SECRET, "", now - 10 * 60 * 1000)
				const staleResponse = yield* post(
					configured.handler,
					"/webhooks/clerk",
					unreadableBody(),
					stale,
				)
				assert.strictEqual(staleResponse.status, 401)

				const oversized = Str.repeat(SVIX_WEBHOOK_MAX_BYTES + 1)("x")
				const signed = yield* signedHeaders(CLERK_SECRET, oversized, now)
				const streamed = yield* post(configured.handler, "/webhooks/clerk", oversized, signed)
				assert.strictEqual(streamed.status, 413)
				const declared = yield* post(configured.handler, "/webhooks/clerk", unreadableBody(), {
					...signed,
					"content-length": String(SVIX_WEBHOOK_MAX_BYTES + 1),
				})
				assert.strictEqual(declared.status, 413)
				assert.strictEqual(events.tracked.length, 0)
			}).pipe(Effect.ensuring(Effect.promise(() => configured.dispose())))
		}),
	)

	// Membership is changed in Clerk, never through Maple's API, so this receiver
	// is the only writer of `affected_user`.
	it.live("audits an organizationMembership.created delivery and emits member_joined", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const audit = recordingAudit()
			const revocation = recordingRevocation()
			const configured = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRoute,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					events.layer,
					revocation.layer,
					audit.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const headers = yield* signedHeaders(CLERK_SECRET, CLERK_MEMBERSHIP_CREATED, now)
				const response = yield* post(
					configured.handler,
					"/webhooks/clerk",
					CLERK_MEMBERSHIP_CREATED,
					headers,
				)
				assert.strictEqual(response.status, 200)
				// The new member's cached membership list must not hide the org they just joined.
				assert.deepStrictEqual(revocation.calls, ["invalidate:user_2abc"])
				assert.strictEqual(audit.recorded.length, 1)
				const entry = audit.recorded[0]
				assert.strictEqual(entry.action, "member.added")
				assert.strictEqual(entry.affectedUserId, "user_2abc")
				assert.strictEqual(entry.orgId, "org_42")
				// Clerk's payload never names the admin who acted; claiming a user
				// here would be a guess, so the entry is Maple recording what it learned.
				assert.strictEqual(entry.actor.type, "system")
				assert.strictEqual(entry.source, "system")
				assert.deepStrictEqual(events.tracked, [
					{
						name: "member_joined",
						userId: "user_2abc",
						groupId: "org_42",
						timestamp: 1_700_000_000_000,
						attributes: { role: "org:admin" },
					},
				])
			}).pipe(Effect.ensuring(Effect.promise(() => configured.dispose())))
		}),
	)

	// One Clerk instance delivers every event to every region's API.
	it.live("sweeps a membership change in every region and records it in the home region", () =>
		Effect.gen(function* () {
			const deliver = (home: HomeAnswer, type: string) =>
				Effect.gen(function* () {
					const events = recordingProductEvents()
					const audit = recordingAudit()
					const revocation = recordingRevocation()
					const configured = HttpRouter.toWebHandler(
						makeRouterLayer(
							ClerkWebhookRoute,
							{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
							events.layer,
							revocation.layer,
							audit.layer,
							recordingCancellationQueue().layer,
							BillingCustomerResolver.standalone,
							regionsAnswering(home),
						),
						{ disableLogger: true },
					)
					return yield* Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis
						const body = JSON.stringify({
							type,
							timestamp: 1_700_000_000_000,
							data: {
								organization: { id: "org_9" },
								public_user_data: { user_id: "user_9" },
								role: "org:member",
							},
						})
						const headers = yield* signedHeaders(CLERK_SECRET, body, now)
						const response = yield* post(configured.handler, "/webhooks/clerk", body, headers)
						return {
							status: response.status,
							audited: audit.recorded.length,
							tracked: events.tracked.length,
							calls: revocation.calls,
						}
					}).pipe(Effect.ensuring(Effect.promise(() => configured.dispose())))
				})

			const removal = "organizationMembership.deleted"
			// Another region's organization: nothing is recorded here, but a key this instance
			// minted before the organization chose its region still has to go.
			assert.deepStrictEqual(yield* deliver("elsewhere", removal), {
				status: 200,
				audited: 0,
				tracked: 0,
				calls: ["revoke:org_9:user_9"],
			})
			assert.deepStrictEqual(yield* deliver("deleted", removal), {
				status: 200,
				audited: 0,
				tracked: 0,
				calls: ["revoke:org_9:user_9"],
			})
			// Clerk could not say where it lives: swept at once, and redelivered for the record.
			assert.deepStrictEqual(yield* deliver("unknown", removal), {
				status: 503,
				audited: 0,
				tracked: 0,
				calls: ["revoke:org_9:user_9"],
			})
			assert.deepStrictEqual(yield* deliver("here", removal), {
				status: 200,
				audited: 1,
				tracked: 1,
				calls: ["revoke:org_9:user_9"],
			})
			// A demotion takes keys away in every region too.
			assert.deepStrictEqual(yield* deliver("elsewhere", "organizationMembership.updated"), {
				status: 200,
				audited: 0,
				tracked: 0,
				calls: [`demote:org_9:user_9:${Arr.join(Policy.grantsOf(["org:member"]), ",")}`],
			})
			// A join only evicts the member's cached membership list; the other region records nothing.
			assert.deepStrictEqual(yield* deliver("elsewhere", "organizationMembership.created"), {
				status: 200,
				audited: 0,
				tracked: 0,
				calls: ["invalidate:user_9"],
			})
			assert.deepStrictEqual(yield* deliver("unknown", "organizationMembership.created"), {
				status: 503,
				audited: 0,
				tracked: 0,
				calls: ["invalidate:user_9"],
			})
		}),
	)

	it.live("counts a signup in the default region only, and sweeps a deleted user in every region", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const revocation = recordingRevocation()
			const configured = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRoute,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					events.layer,
					revocation.layer,
					recordingAudit().layer,
					recordingCancellationQueue().layer,
					BillingCustomerResolver.standalone,
					regionsAnswering("elsewhere", "eu"),
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const createdHeaders = yield* signedHeaders(CLERK_SECRET, CLERK_USER_CREATED, now, "msg_new")
				const created = yield* post(
					configured.handler,
					"/webhooks/clerk",
					CLERK_USER_CREATED,
					createdHeaders,
				)
				assert.strictEqual(created.status, 200)
				assert.deepStrictEqual(events.tracked, [])

				const userDeleted = JSON.stringify({ type: "user.deleted", data: { id: "user_9" } })
				const deletedHeaders = yield* signedHeaders(CLERK_SECRET, userDeleted, now, "msg_gone")
				const deleted = yield* post(
					configured.handler,
					"/webhooks/clerk",
					userDeleted,
					deletedHeaders,
				)
				assert.strictEqual(deleted.status, 200)
				assert.deepStrictEqual(revocation.calls, ["revokeUser:user_9"])
			}).pipe(Effect.ensuring(Effect.promise(() => configured.dispose())))
		}),
	)

	it.live(
		"503s while unconfigured, 401s a bad signature, and emits signup_completed for user.created",
		() =>
			Effect.gen(function* () {
				const events = recordingProductEvents()
				const unconfigured = HttpRouter.toWebHandler(
					makeRouterLayer(ClerkWebhookRoute, {}, events.layer),
					{
						disableLogger: true,
					},
				)
				yield* Effect.gen(function* () {
					const response = yield* post(
						unconfigured.handler,
						"/webhooks/clerk",
						CLERK_USER_CREATED,
						{},
					)
					assert.strictEqual(response.status, 503)
				}).pipe(Effect.ensuring(Effect.promise(unconfigured.dispose)))

				const configured = HttpRouter.toWebHandler(
					makeRouterLayer(ClerkWebhookRoute, { CLERK_WEBHOOK_SECRET: CLERK_SECRET }, events.layer),
					{ disableLogger: true },
				)
				yield* Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const missing = yield* post(configured.handler, "/webhooks/clerk", CLERK_USER_CREATED, {})
					assert.strictEqual(missing.status, 401)

					const stale = yield* signedHeaders(CLERK_SECRET, CLERK_USER_CREATED, now - 10 * 60 * 1000)
					const staleResponse = yield* post(
						configured.handler,
						"/webhooks/clerk",
						CLERK_USER_CREATED,
						stale,
					)
					assert.strictEqual(staleResponse.status, 401)

					const tampered = yield* signedHeaders(CLERK_SECRET, CLERK_USER_CREATED, now)
					const tamperedResponse = yield* post(
						configured.handler,
						"/webhooks/clerk",
						Str.replace("user_2abc", "user_evil")(CLERK_USER_CREATED),
						tampered,
					)
					assert.strictEqual(tamperedResponse.status, 401)
					assert.strictEqual(events.tracked.length, 0)

					const ok = yield* signedHeaders(CLERK_SECRET, CLERK_USER_CREATED, now)
					const accepted = yield* post(
						configured.handler,
						"/webhooks/clerk",
						CLERK_USER_CREATED,
						ok,
					)
					assert.strictEqual(accepted.status, 200)
					assert.deepStrictEqual(events.tracked, [
						{
							name: "signup_completed",
							userId: "user_2abc",
							timestamp: 1_700_000_000_000,
							attributes: { sign_up_source: "github", email_domain: "example.com" },
						},
					])

					// Other event types are acknowledged and ignored.
					const other = JSON.stringify({ type: "session.created", data: { id: "sess_1" } })
					const otherHeaders = yield* signedHeaders(CLERK_SECRET, other, now, "msg_other")
					const ignored = yield* post(configured.handler, "/webhooks/clerk", other, otherHeaders)
					assert.strictEqual(ignored.status, 200)
					assert.strictEqual(events.tracked.length, 1)
				}).pipe(Effect.ensuring(Effect.promise(configured.dispose)))
			}),
	)
	it.live("sweeps a removed member, only invalidates on a role change, and 500s a failed sweep", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const revocation = recordingRevocation()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRoute,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					events.layer,
					revocation.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const membership = (type: string, role?: string) =>
					JSON.stringify({
						type,
						data: {
							organization: { id: "org_9" },
							public_user_data: { user_id: "user_9" },
							...(role === undefined ? undefined : { role }),
						},
					})

				const deleted = membership("organizationMembership.deleted")
				const deletedHeaders = yield* signedHeaders(CLERK_SECRET, deleted, now, "msg_del")
				const deletedResponse = yield* post(handler, "/webhooks/clerk", deleted, deletedHeaders)
				assert.strictEqual(deletedResponse.status, 200)

				const updated = membership("organizationMembership.updated", "org:member")
				const updatedHeaders = yield* signedHeaders(CLERK_SECRET, updated, now, "msg_upd")
				const updatedResponse = yield* post(handler, "/webhooks/clerk", updated, updatedHeaders)
				assert.strictEqual(updatedResponse.status, 200)

				const userDeleted = JSON.stringify({ type: "user.deleted", data: { id: "user_9" } })
				const userHeaders = yield* signedHeaders(CLERK_SECRET, userDeleted, now, "msg_user_del")
				const userResponse = yield* post(handler, "/webhooks/clerk", userDeleted, userHeaders)
				assert.strictEqual(userResponse.status, 200)

				// A role change goes to the demotion sweep carrying the *new* role, so
				// keys pinned to the role the member just lost are retired.
				assert.deepStrictEqual(revocation.calls, [
					"revoke:org_9:user_9",
					`demote:org_9:user_9:${Arr.join(Policy.grantsOf(["org:member"]), ",")}`,
					"revokeUser:user_9",
				])
				// The removal is a product event on the member and org; a role change is not.
				assert.deepStrictEqual(
					Arr.map(events.tracked, (event) => [event.name, event.userId, event.groupId]),
					[["member_removed", "user_9", "org_9"]],
				)

				// A custom role's permissions come from the membership's public metadata.
				const custom = JSON.stringify({
					type: "organizationMembership.updated",
					data: {
						organization: { id: "org_9" },
						public_user_data: { user_id: "user_9" },
						role: "org:custom",
						public_metadata: {
							maple_role: {
								id: "role_abcdefghijkl",
								permissions: Policy.encodePermissions(["telemetry:read", "alerts:manage"]),
							},
						},
					},
				})
				const customHeaders = yield* signedHeaders(CLERK_SECRET, custom, now, "msg_upd_custom")
				const customResponse = yield* post(handler, "/webhooks/clerk", custom, customHeaders)
				assert.strictEqual(customResponse.status, 200)
				assert.strictEqual(
					revocation.calls.at(-1),
					`demote:org_9:user_9:${Arr.join(Policy.grantsOf(["org:custom"], ["telemetry:read", "alerts:manage"]), ",")}`,
				)

				// No role in the payload: we cannot tell demotion from promotion, so
				// the caches are evicted and nothing is revoked on a guess.
				const roleless = membership("organizationMembership.updated")
				const rolelessHeaders = yield* signedHeaders(CLERK_SECRET, roleless, now, "msg_upd_norole")
				const rolelessResponse = yield* post(handler, "/webhooks/clerk", roleless, rolelessHeaders)
				assert.strictEqual(rolelessResponse.status, 200)
				assert.strictEqual(revocation.calls.at(-1), "invalidate:user_9")

				// Clerk's delete envelope may omit the id. Nothing to sweep and no
				// retry can produce one, so it is a logged 200, not a 400 that burns
				// the retry budget and ends as a failed delivery nobody sees.
				const idless = JSON.stringify({
					type: "user.deleted",
					data: { object: "user", deleted: true },
				})
				const idlessHeaders = yield* signedHeaders(CLERK_SECRET, idless, now, "msg_user_noid")
				const idlessResponse = yield* post(handler, "/webhooks/clerk", idless, idlessHeaders)
				assert.strictEqual(idlessResponse.status, 200)
				assert.strictEqual(revocation.calls.at(-1), "invalidate:user_9")

				// An unrecognized membership shape is a 400, not a silent 200.
				const malformed = JSON.stringify({
					type: "organizationMembership.deleted",
					data: { organization: {} },
				})
				const malformedHeaders = yield* signedHeaders(CLERK_SECRET, malformed, now, "msg_bad")
				const malformedResponse = yield* post(handler, "/webhooks/clerk", malformed, malformedHeaders)
				assert.strictEqual(malformedResponse.status, 400)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))

			// A half-run sweep must be loud: 500 so Clerk retries the delivery.
			const failing = recordingRevocation(true)
			const broken = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRoute,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					events.layer,
					failing.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const body = JSON.stringify({
					type: "organizationMembership.deleted",
					data: {
						organization: { id: "org_9" },
						public_user_data: { user_id: "user_9" },
					},
				})
				const headers = yield* signedHeaders(
					CLERK_SECRET,
					body,
					yield* Clock.currentTimeMillis,
					"msg_fail",
				)
				const before = events.tracked.length
				const response = yield* post(broken.handler, "/webhooks/clerk", body, headers)
				assert.strictEqual(response.status, 500)
				// Clerk retries a 500, so the failed delivery must not emit member_removed.
				assert.strictEqual(events.tracked.length, before)
			}).pipe(Effect.ensuring(Effect.promise(broken.dispose)))
		}),
	)

	// SCIM: groups feed the role mapping picker; a deprovisioned user loses every credential.
	it.live("stores directory groups and sweeps a deprovisioned user in every region", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const revocation = recordingRevocation()
			const sso = recordingSso()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRoute,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					events.layer,
					revocation.layer,
					undefined,
					undefined,
					undefined,
					// The org lives elsewhere: the sweep still runs here.
					regionsAnswering("elsewhere", "eu"),
					sso.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const send = (id: string, payload: unknown) =>
					Effect.gen(function* () {
						const body = JSON.stringify(payload)
						const headers = yield* signedHeaders(CLERK_SECRET, body, now, id)
						return yield* post(handler, "/webhooks/clerk", body, headers)
					})
				const group = {
					id: "grp_1",
					directory_id: "dir_1",
					display_name: "Maple Admins",
					updated_at: now,
				}

				const created = yield* send("msg_g1", { type: "directoryGroup.created", data: group })
				assert.strictEqual(created.status, 200)
				const removed = yield* send("msg_g2", { type: "directoryGroup.deleted", data: group })
				assert.strictEqual(removed.status, 200)
				assert.deepStrictEqual(
					Arr.map(sso.applied, (e) => [e.directoryId, e.groupId, e.displayName, e.deleted]),
					[
						["dir_1", "grp_1", "Maple Admins", false],
						["dir_1", "grp_1", "Maple Admins", true],
					],
				)

				const malformed = yield* send("msg_g3", {
					type: "directoryGroup.created",
					data: { id: "grp_2" },
				})
				assert.strictEqual(malformed.status, 400)

				// Reactivation and ordinary profile edits revoke nothing.
				const active = yield* send("msg_u1", {
					type: "user.updated",
					data: { id: "user_5", deprovisioned: false },
				})
				const edited = yield* send("msg_u2", { type: "user.updated", data: { id: "user_5" } })
				assert.strictEqual(active.status, 200)
				assert.strictEqual(edited.status, 200)
				assert.deepStrictEqual(revocation.calls, [])

				const deprovisioned = yield* send("msg_u3", {
					type: "user.updated",
					data: { id: "user_5", deprovisioned: true },
				})
				assert.strictEqual(deprovisioned.status, 200)
				assert.deepStrictEqual(revocation.calls, ["revokeUser:user_5"])
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)

	it.live("ignores a deprovision delivery Clerk no longer stands behind (the user was reactivated)", () =>
		Effect.gen(function* () {
			const revocation = recordingRevocation()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRoute,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					recordingProductEvents().layer,
					revocation.layer,
					undefined,
					undefined,
					undefined,
					undefined,
					EnterpriseSsoService.webhookOnly(
						() => Effect.succeed("not_here" as const),
						() => Effect.succeed(false),
					),
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const body = JSON.stringify({
					type: "user.updated",
					data: { id: "user_7", deprovisioned: true },
				})
				const headers = yield* signedHeaders(CLERK_SECRET, body, now, "msg_stale")
				const response = yield* post(handler, "/webhooks/clerk", body, headers)
				assert.strictEqual(response.status, 200)
				assert.deepStrictEqual(revocation.calls, [])
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)

	it.live(
		"takes a removed member off the org's SSO bypass list after the sweep, and retries when that fails",
		() =>
			Effect.gen(function* () {
				const revocation = recordingRevocation()
				const events = recordingProductEvents()
				const clerk = { down: false }
				const removals: Array<string> = []
				const sso = EnterpriseSsoService.webhookOnly(
					() => Effect.succeed("not_here" as const),
					() => Effect.succeed(true),
					(orgId, userId) =>
						Effect.suspend(() => {
							// The sweep has already run by the time the bypass entry goes.
							removals.push(`${orgId}:${userId} after ${revocation.calls.at(-1) ?? "nothing"}`)
							return clerk.down
								? Effect.fail(new EnterpriseSsoUnavailableError({ message: "Clerk is down" }))
								: Effect.succeed("removed" as const)
						}),
				)
				const { handler, dispose } = HttpRouter.toWebHandler(
					makeRouterLayer(
						ClerkWebhookRoute,
						{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
						events.layer,
						revocation.layer,
						undefined,
						undefined,
						undefined,
						undefined,
						sso,
					),
					{ disableLogger: true },
				)
				yield* Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const send = (type: string, id: string) =>
						Effect.gen(function* () {
							const body = JSON.stringify({
								type,
								data: {
									organization: { id: "org_9" },
									public_user_data: { user_id: "user_9" },
									role: "org:member",
								},
							})
							const headers = yield* signedHeaders(CLERK_SECRET, body, now, id)
							return yield* post(handler, "/webhooks/clerk", body, headers)
						})

					// Joining or changing role leaves the list alone.
					yield* send("organizationMembership.created", "msg_bp_created")
					yield* send("organizationMembership.updated", "msg_bp_updated")
					assert.deepStrictEqual(removals, [])

					const removed = yield* send("organizationMembership.deleted", "msg_bp_deleted")
					assert.strictEqual(removed.status, 200)
					assert.deepStrictEqual(removals, ["org_9:user_9 after revoke:org_9:user_9"])

					// Clerk redelivers a 500, so a failed removal must not count the member as removed twice.
					clerk.down = true
					const tracked = events.tracked.length
					const failed = yield* send("organizationMembership.deleted", "msg_bp_failed")
					assert.strictEqual(failed.status, 500)
					assert.strictEqual(events.tracked.length, tracked)
				}).pipe(Effect.ensuring(Effect.promise(dispose)))
			}),
	)

	it.live("500s a directory group the database could not save, so Clerk redelivers it", () =>
		Effect.gen(function* () {
			const failing = EnterpriseSsoService.webhookOnly(() =>
				Effect.fail(new EnterpriseSsoUnavailableError({ message: "db down" })),
			)
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRoute,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					recordingProductEvents().layer,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					failing,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const body = JSON.stringify({
					type: "directoryGroup.updated",
					data: { id: "grp_1", directory_id: "dir_1", display_name: "Admins", updated_at: now },
				})
				const headers = yield* signedHeaders(CLERK_SECRET, body, now, "msg_gf")
				const response = yield* post(handler, "/webhooks/clerk", body, headers)
				assert.strictEqual(response.status, 500)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)
})

const AUTUMN_CANCEL_SCHEDULED = JSON.stringify({
	type: "billing.updated",
	data: {
		object: "billing.updated",
		customer_id: "org_42",
		plan_changes: [
			{
				action: "updated",
				subscription: {
					plan_id: "startup",
					status: "active",
					past_due: false,
					started_at: 1_759_248_000_000,
					canceled_at: 1_761_840_000_000,
					expires_at: 1_764_432_000_000,
					trial_ends_at: null,
					current_period_start: 1_761_840_000_000,
					current_period_end: 1_764_432_000_000,
				},
				previous_attributes: { canceled_at: null, expires_at: null },
				item_changes: [],
			},
		],
		tags: [],
	},
})

describe("AutumnWebhookRouter", () => {
	it.live("queues a scheduled cancellation for its review", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const reviews = recordingCancellationQueue()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					AutumnWebhookRouter,
					{
						AUTUMN_WEBHOOK_SECRET: AUTUMN_SECRET,
						MAPLE_CANCELLATION_SLACK_CHANNEL_ID: "C_CANCELLATIONS",
					},
					events.layer,
					undefined,
					undefined,
					reviews.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const headers = yield* signedHeaders(
					AUTUMN_SECRET,
					AUTUMN_CANCEL_SCHEDULED,
					yield* Clock.currentTimeMillis,
				)
				const response = yield* post(handler, "/webhooks/autumn", AUTUMN_CANCEL_SCHEDULED, headers)
				assert.strictEqual(response.status, 200)
				assert.deepStrictEqual(
					// What the consumer decodes off the queue.
					Arr.map(reviews.queued, (body) => {
						const { receivedAt: _receivedAt, ...cancellation } = decodeQueuedJob(body)
						return cancellation
					}),
					[
						{
							orgId: "org_42",
							planId: "startup",
							phase: "scheduled",
							startedAt: 1_759_248_000_000,
							canceledAt: 1_761_840_000_000,
							expiresAt: 1_764_432_000_000,
							trial: false,
							pastDue: false,
						},
					],
				)
				// `updated` is still a plan change to the funnel.
				assert.deepStrictEqual(
					Arr.map(events.tracked, (event) => event.name),
					["plan_changed"],
				)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)

	it.live("queues no review for an org whose plan ended because it is billed through another", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const reviews = recordingCancellationQueue()
			const payer = Schema.decodeSync(OrgId)("org_payer")
			const linked = Layer.succeed(BillingCustomerResolver, {
				billingOrgId: () => Effect.succeed(payer),
				customerFor: () => Effect.succeed(BillingCustomerId.make(payer)),
				requireOwnBilling: () => Effect.die("not used"),
				readLink: () => Effect.succeedSome(payer),
				forget: () => Effect.void,
			})
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					AutumnWebhookRouter,
					{
						AUTUMN_WEBHOOK_SECRET: AUTUMN_SECRET,
						MAPLE_CANCELLATION_SLACK_CHANNEL_ID: "C_CANCELLATIONS",
					},
					events.layer,
					undefined,
					undefined,
					reviews.layer,
					linked,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const headers = yield* signedHeaders(
					AUTUMN_SECRET,
					AUTUMN_CANCEL_SCHEDULED,
					yield* Clock.currentTimeMillis,
				)
				const response = yield* post(handler, "/webhooks/autumn", AUTUMN_CANCEL_SCHEDULED, headers)
				assert.strictEqual(response.status, 200)
				assert.deepStrictEqual(reviews.queued, [])
				assert.deepStrictEqual(events.tracked, [])
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)

	it.live("asks for redelivery when it cannot tell whether the org is billed elsewhere", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const reviews = recordingCancellationQueue()
			const unreadable = Layer.succeed(BillingCustomerResolver, {
				billingOrgId: () => Effect.die("not used"),
				customerFor: () => Effect.die("not used"),
				requireOwnBilling: () => Effect.die("not used"),
				readLink: () => Effect.fail(new BillingAccountPersistenceError({ message: "postgres down" })),
				forget: () => Effect.void,
			})
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					AutumnWebhookRouter,
					{
						AUTUMN_WEBHOOK_SECRET: AUTUMN_SECRET,
						MAPLE_CANCELLATION_SLACK_CHANNEL_ID: "C_CANCELLATIONS",
					},
					events.layer,
					undefined,
					undefined,
					reviews.layer,
					unreadable,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const headers = yield* signedHeaders(
					AUTUMN_SECRET,
					AUTUMN_CANCEL_SCHEDULED,
					yield* Clock.currentTimeMillis,
				)
				const response = yield* post(handler, "/webhooks/autumn", AUTUMN_CANCEL_SCHEDULED, headers)
				assert.strictEqual(response.status, 503)
				assert.deepStrictEqual(reviews.queued, [])
				assert.deepStrictEqual(events.tracked, [])
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)

	it.live("reviews nothing on a deployment with no channel to report to", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const reviews = recordingCancellationQueue()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					AutumnWebhookRouter,
					{ AUTUMN_WEBHOOK_SECRET: AUTUMN_SECRET },
					events.layer,
					undefined,
					undefined,
					reviews.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const headers = yield* signedHeaders(
					AUTUMN_SECRET,
					AUTUMN_CANCEL_SCHEDULED,
					yield* Clock.currentTimeMillis,
				)
				const response = yield* post(handler, "/webhooks/autumn", AUTUMN_CANCEL_SCHEDULED, headers)
				assert.strictEqual(response.status, 200)
				assert.deepStrictEqual(reviews.queued, [])
				assert.strictEqual(events.tracked.length, 1)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)

	it.live("queues a cancellation on a deployment that reports to Hazel alone", () =>
		Effect.gen(function* () {
			const reviews = recordingCancellationQueue()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					AutumnWebhookRouter,
					{
						AUTUMN_WEBHOOK_SECRET: AUTUMN_SECRET,
						MAPLE_CANCELLATION_HAZEL_CHANNEL_ID: "hazel-cancellations",
					},
					recordingProductEvents().layer,
					undefined,
					undefined,
					reviews.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const headers = yield* signedHeaders(
					AUTUMN_SECRET,
					AUTUMN_CANCEL_SCHEDULED,
					yield* Clock.currentTimeMillis,
				)
				const response = yield* post(handler, "/webhooks/autumn", AUTUMN_CANCEL_SCHEDULED, headers)
				assert.strictEqual(response.status, 200)
				assert.deepStrictEqual(
					Arr.map(reviews.queued, (body) => decodeQueuedJob(body).planId),
					["startup"],
				)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)

	it.live("records the plan events, then answers 503, when the review could not be queued", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					AutumnWebhookRouter,
					{
						AUTUMN_WEBHOOK_SECRET: AUTUMN_SECRET,
						MAPLE_CANCELLATION_SLACK_CHANNEL_ID: "C_CANCELLATIONS",
					},
					events.layer,
					undefined,
					undefined,
					recordingCancellationQueue(true).layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const headers = yield* signedHeaders(
					AUTUMN_SECRET,
					AUTUMN_CANCEL_SCHEDULED,
					yield* Clock.currentTimeMillis,
				)
				const response = yield* post(handler, "/webhooks/autumn", AUTUMN_CANCEL_SCHEDULED, headers)
				assert.strictEqual(response.status, 503)
				// The funnel does not wait on the review.
				assert.deepStrictEqual(
					Arr.map(events.tracked, (event) => event.name),
					["plan_changed"],
				)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)

	it.live("emits plan_started for an activated plan and plan_cancelled for the expired one", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(AutumnWebhookRouter, { AUTUMN_WEBHOOK_SECRET: AUTUMN_SECRET }, events.layer),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const wrongSecret = yield* signedHeaders(CLERK_SECRET, AUTUMN_BILLING_UPDATED, now)
				const rejected = yield* post(handler, "/webhooks/autumn", AUTUMN_BILLING_UPDATED, wrongSecret)
				assert.strictEqual(rejected.status, 401)

				const ok = yield* signedHeaders(AUTUMN_SECRET, AUTUMN_BILLING_UPDATED, now, "msg_autumn_1")
				const accepted = yield* post(handler, "/webhooks/autumn", AUTUMN_BILLING_UPDATED, ok)
				assert.strictEqual(accepted.status, 200)
				assert.deepStrictEqual(events.tracked, [
					{
						name: "plan_started",
						groupId: "org_42",
						timestamp: 1_761_840_000_000,
						attributes: {
							plan_id: "startup",
							trigger: "webhook",
							kind: "subscription",
							subscription_started_at: "1761840000000",
							webhook_message_id: "msg_autumn_1",
						},
					},
					{
						name: "plan_cancelled",
						groupId: "org_42",
						timestamp: undefined,
						attributes: {
							plan_id: "free",
							trigger: "webhook",
							kind: "subscription",
							subscription_started_at: "1759248000000",
							webhook_message_id: "msg_autumn_1",
						},
					},
				])
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)
})
