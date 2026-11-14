import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { graphqlQuery, listHyperdriveConfigs, listWorkerScripts, listZones } from "./CloudflareApi"

const BASE = "https://cf.test/client/v4"

const envelope = (result: unknown, resultInfo?: Readonly<Record<string, number>>) =>
	VendorFake.json({
		success: true,
		errors: [],
		messages: [],
		result,
		...(resultInfo === undefined ? undefined : { result_info: resultInfo }),
	})

const refused = (status: number, code: number, message: string) =>
	VendorFake.json({ success: false, errors: [{ code, message }], messages: [], result: null }, status)

const zone = (index: number) => ({ id: `zone-${index}`, name: `z${index}.example.com`, status: "active" })

describe("Cloudflare API access", () => {
	it.effect("pages zones until total_count and reports a listing past the cap as truncated", () =>
		Effect.gen(function* () {
			const total = 260
			const fake = VendorFake.make({
				routes: [
					{
						path: "/client/v4/zones",
						respond: (request) => {
							const page = Number(request.search.get("page"))
							const start = (page - 1) * 50
							const count = Math.max(0, Math.min(50, total - start))
							return envelope(
								Array.from({ length: count }, (_, index) => zone(start + index)),
								{ page, per_page: 50, count, total_count: total },
							)
						},
					},
				],
			})
			const zones = yield* listZones("token", "acc_1", BASE).pipe(Effect.provide(fake.layer))
			assert.lengthOf(zones.items, 200)
			assert.isTrue(zones.truncated)
			// Five pages hold the 201st zone; the sixth is never asked for.
			assert.lengthOf(fake.calls, 5)
			assert.strictEqual(fake.calls[0]?.search.get("account.id"), "acc_1")
			assert.strictEqual(fake.calls[0]?.authorization, "Bearer token")
		}),
	)

	it.effect("stops when Cloudflare answers a page other than the one asked for", () =>
		Effect.gen(function* () {
			const fake = VendorFake.make({
				routes: [
					{
						path: "/client/v4/zones",
						respond: () =>
							envelope([zone(0)], { page: 1, per_page: 1, count: 1, total_count: 9 }),
					},
				],
			})
			const zones = yield* listZones("token", "acc_1", BASE).pipe(Effect.provide(fake.layer))
			assert.deepStrictEqual(
				Arr.map(zones.items, (item) => item.id),
				["zone-0"],
			)
			assert.lengthOf(fake.calls, 2)
		}),
	)

	it.effect("marks a listing truncated when Cloudflare ignores the page it was asked for", () =>
		Effect.gen(function* () {
			const fake = VendorFake.make({
				routes: [
					{
						path: "/client/v4/zones",
						respond: () =>
							envelope(Arr.map(Arr.range(0, 49), zone), {
								page: 1,
								per_page: 50,
								total_pages: 3,
							}),
					},
				],
			})
			const zones = yield* listZones("token", "acc_1", BASE).pipe(Effect.provide(fake.layer))
			assert.lengthOf(zones.items, 50)
			assert.isTrue(zones.truncated)
		}),
	)

	it.effect("retries an 'Authentication error' blip and succeeds", () =>
		Effect.gen(function* () {
			let attempts = 0
			const fake = VendorFake.make({
				routes: [
					{
						path: "/client/v4/accounts/acc_1/workers/scripts",
						respond: () => {
							attempts += 1
							// Five blips in a row still recover, as they did under the SDK's 8 retries.
							return attempts <= 5
								? refused(400, 10000, "Authentication error")
								: envelope([{ id: "api" }])
						},
					},
				],
			})
			const scripts = yield* VendorFake.elapsing(
				listWorkerScripts("token", "acc_1", BASE).pipe(Effect.provide(fake.layer)),
			)
			assert.deepStrictEqual(scripts.items, ["api"])
			assert.lengthOf(fake.calls, 6)
		}),
	)

	it.effect("retries an auth blip in a 200 envelope with no result, then succeeds", () =>
		Effect.gen(function* () {
			let attempts = 0
			const fake = VendorFake.make({
				routes: [
					{
						path: "/client/v4/accounts/acc_1/workers/scripts",
						respond: () => {
							attempts += 1
							return attempts === 1
								? VendorFake.json({
										success: false,
										errors: [{ code: 10000, message: "Authentication error" }],
										messages: [],
									})
								: envelope([{ id: "api" }])
						},
					},
				],
			})
			const scripts = yield* VendorFake.elapsing(
				listWorkerScripts("token", "acc_1", BASE).pipe(Effect.provide(fake.layer)),
			)
			assert.deepStrictEqual(scripts.items, ["api"])
			assert.lengthOf(fake.calls, 2)
		}),
	)

	it.effect("reads an auth code in a 200 envelope with no result as a revoked token", () =>
		Effect.gen(function* () {
			const fake = VendorFake.make({
				routes: [
					{
						respond: () =>
							VendorFake.json({
								success: false,
								errors: [{ code: 9109, message: "Invalid access token" }],
								messages: [],
							}),
					},
				],
			})
			const error = yield* Effect.flip(
				listZones("token", "acc_1", BASE).pipe(Effect.provide(fake.layer)),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			assert.lengthOf(fake.calls, 1)
		}),
	)

	it.effect("reads an auth code in a 400 envelope as a revoked token, without retrying", () =>
		Effect.gen(function* () {
			const fake = VendorFake.make({
				routes: [{ respond: () => refused(400, 9109, "Invalid access token") }],
			})
			const error = yield* Effect.flip(
				listZones("token", "acc_1", BASE).pipe(Effect.provide(fake.layer)),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			assert.lengthOf(fake.calls, 1)
		}),
	)

	it.effect("fails a 200 whose envelope says success: false, with Cloudflare's message", () =>
		Effect.gen(function* () {
			const fake = VendorFake.make({
				routes: [{ respond: () => refused(200, 7003, "Could not route to /accounts/x") }],
			})
			const error = yield* Effect.flip(
				listHyperdriveConfigs("token", "acc_1", BASE).pipe(Effect.provide(fake.layer)),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.strictEqual(error.message, "Could not route to /accounts/x")
		}),
	)

	it.effect("normalizes a VPC-service Hyperdrive origin to no host and no port", () =>
		Effect.gen(function* () {
			const fake = VendorFake.make({
				routes: [
					{
						path: "/client/v4/accounts/acc_1/hyperdrive/configs",
						respond: (request) =>
							request.search.get("page") === "1"
								? envelope([
										{
											id: "hd_1",
											name: "db",
											origin: {
												serviceId: "svc",
												host: "ignored",
												database: "app",
												scheme: "postgres",
											},
										},
									])
								: envelope([]),
					},
				],
			})
			const configs = yield* listHyperdriveConfigs("token", "acc_1", BASE).pipe(
				Effect.provide(fake.layer),
			)
			assert.deepStrictEqual(configs.items[0]?.origin, {
				host: null,
				port: null,
				database: "app",
				scheme: "postgres",
				user: null,
			})
		}),
	)

	it.effect("retries a 5xx on a GraphQL query, though it is a POST, and returns its GraphQL errors", () =>
		Effect.gen(function* () {
			let attempts = 0
			const fake = VendorFake.make({
				routes: [
					{
						method: "POST",
						path: "/client/v4/graphql",
						respond: () => {
							attempts += 1
							return attempts === 1
								? VendorFake.text("bad gateway", 502)
								: VendorFake.json({
										data: null,
										errors: [{ message: "dataset not on plan" }],
									})
						},
					},
				],
			})
			const result = yield* VendorFake.elapsing(
				graphqlQuery("token", { query: "{ viewer { zones { zoneTag } } }" }, BASE).pipe(
					Effect.provide(fake.layer),
				),
			)
			assert.deepStrictEqual(
				Arr.map(result.errors, (error) => error.message),
				["dataset not on plan"],
			)
			assert.lengthOf(fake.calls, 2)
		}),
	)
})
