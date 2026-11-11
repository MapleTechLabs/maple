import * as Category from "@distilled.cloud/aws/Category"
import * as Retry from "@distilled.cloud/aws/Retry"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Number as Num, Order, Redacted, Array as Arr } from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import type { AwsRoleSession } from "../../../integrations/aws/api"
import { FIXTURE_DETAILED, FIXTURE_ITEMS, FIXTURE_WINDOW } from "./cost-fixture"
import { pullCostExplorer } from "./cost-explorer"
import { type FakeCostExplorer, makeFakeCostExplorer } from "./fake-cost-explorer"

const ACCOUNT = "000000000000"

// What an assumed role signs with. The fake accepts any session key with a token.
const session: AwsRoleSession = {
	accountId: ACCOUNT,
	credentials: Effect.succeed({
		accessKeyId: Redacted.make("ASIA0000000000000000"),
		secretAccessKey: Redacted.make("secret"),
		sessionToken: Redacted.make("token"),
		region: "us-east-1",
	}),
}

// Cost Explorer is the only endpoint a pull may call.
const nothingElse = HttpClient.make((request) => Effect.die(`unexpected call to ${request.url}`))

const makeFake = () => makeFakeCostExplorer(nothingElse, FIXTURE_ITEMS)

/** A pull without the SDK's backoff sleeps, which never end under the test clock. */
const pull = (fake: FakeCostExplorer, window = FIXTURE_WINDOW) =>
	Retry.none(pullCostExplorer(fake.client, session, ACCOUNT, window))

const total = (values: ReadonlyArray<number>) => Num.sumAll(values)

describe("pullCostExplorer", () => {
	it.effect("asks once by region, then once by usage type for each region that matters", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const pulled = yield* pull(fake)

			assert.deepStrictEqual(pulled.detailedRegions, FIXTURE_DETAILED)
			assert.strictEqual(pulled.requests, 4)
			const [byRegion, ...byUsage] = fake.requests
			// The window's last day is 2026-03-01: Cost Explorer's `End` is exclusive.
			assert.deepStrictEqual(byRegion, {
				TimePeriod: { Start: "2026-02-27", End: "2026-03-02" },
				Granularity: "DAILY",
				Metrics: ["UnblendedCost", "AmortizedCost", "UsageQuantity"],
				GroupBy: [
					{ Type: "DIMENSION", Key: "SERVICE" },
					{ Type: "DIMENSION", Key: "REGION" },
				],
			})
			assert.deepStrictEqual(
				Arr.map(byUsage, (request) => [request.GroupBy, request.Filter, request.TimePeriod]),
				Arr.map(FIXTURE_DETAILED, (region) => [
					[
						{ Type: "DIMENSION", Key: "SERVICE" },
						{ Type: "DIMENSION", Key: "USAGE_TYPE" },
					],
					{ Dimensions: { Key: "REGION", Values: [region] } },
					{ Start: "2026-02-27", End: "2026-03-02" },
				]),
			)

			// Every charge is in exactly one row: the rows add up to the account's cost.
			assert.closeTo(
				total(Arr.map(pulled.rows, (row) => row.billedCost)),
				total(Arr.map(FIXTURE_ITEMS, (item) => item.cost)),
				1e-9,
			)
			const usageTyped = Arr.dedupe(
				Arr.map(
					Arr.filter(pulled.rows, (row) => row.usageType !== ""),
					(row) => row.region,
				),
			)
			assert.deepStrictEqual(Arr.sort(usageTyped, Order.String), FIXTURE_DETAILED)
			assert.isTrue(Arr.every(pulled.rows, (row) => row.accountId === ACCOUNT))
		}),
	)

	it.effect("follows NextPageToken to the last page and counts every page", () =>
		Effect.gen(function* () {
			const whole = yield* pull(makeFake())
			const fake = makeFake()
			fake.options = { pageSize: 4 }
			const paged = yield* pull(fake)

			// 17 groups by region, then 12, 1 and 6 by usage type: 5 + 3 + 1 + 2 pages of four.
			assert.strictEqual(paged.requests, 11)
			assert.lengthOf(fake.requests, 11)
			assert.deepStrictEqual(
				Arr.map(fake.requests, (request) => [
					request.Filter?.Dimensions.Values[0] ?? "(all)",
					request.NextPageToken ?? "(first)",
				]),
				[
					["(all)", "(first)"],
					["(all)", "page-4"],
					["(all)", "page-8"],
					["(all)", "page-12"],
					["(all)", "page-16"],
					["eu-central-1", "(first)"],
					["eu-central-1", "page-4"],
					["eu-central-1", "page-8"],
					["global", "(first)"],
					["us-east-1", "(first)"],
					["us-east-1", "page-4"],
				],
			)
			assert.deepStrictEqual(paged.rows, whole.rows)
		}),
	)

	it.effect("reports a role without the cost policy as not ready", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			fake.failWith = () => "AccessDeniedException"
			const error = yield* Effect.flip(pull(fake))
			assert.strictEqual(error.reason, "not_ready")
			assert.strictEqual(error.provider, "aws")
			assert.strictEqual(error.requests, 1)
			assert.lengthOf(fake.requests, 1)
		}),
	)

	it.effect("reports an account Cost Explorer has no data for as not ready", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			fake.failWith = () => "DataUnavailableException"
			const error = yield* Effect.flip(pull(fake))
			assert.strictEqual(error.reason, "not_ready")
		}),
	)

	it.effect("reports throttling as rate limited, with the requests sent before it", () =>
		Effect.gen(function* () {
			const throttled = makeFake()
			throttled.failWith = (_, index) => (index === 2 ? "ThrottlingException" : undefined)
			const error = yield* Effect.flip(pull(throttled))
			assert.strictEqual(error.reason, "rate_limited")
			assert.strictEqual(error.requests, 3)

			const limited = makeFake()
			limited.failWith = (_, index) => (index === 1 ? "LimitExceededException" : undefined)
			const limit = yield* Effect.flip(pull(limited))
			assert.strictEqual(limit.reason, "rate_limited")
			assert.strictEqual(limit.requests, 2)
		}),
	)

	it.effect("counts the retries of a throttled request, and stops retrying", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			fake.failWith = () => "ThrottlingException"
			const error = yield* Effect.flip(
				pullCostExplorer(fake.client, session, ACCOUNT, FIXTURE_WINDOW).pipe(
					Retry.policy({
						while: Category.isTransientError,
						backoff: { baseMs: 0, factor: 1, capMs: 0, maxRetries: 2 },
					}),
				),
			)
			assert.strictEqual(error.reason, "rate_limited")
			assert.strictEqual(error.requests, 3)
		}),
	)

	it.effect("recovers when a retry succeeds, still counting the failed request", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			fake.failWith = (_, index) => (index === 0 ? "ThrottlingException" : undefined)
			const pulled = yield* pullCostExplorer(fake.client, session, ACCOUNT, FIXTURE_WINDOW).pipe(
				Retry.policy({
					while: Category.isTransientError,
					backoff: { baseMs: 0, factor: 1, capMs: 0, maxRetries: 2 },
				}),
			)
			assert.strictEqual(pulled.requests, 5)
			assert.deepStrictEqual(pulled.detailedRegions, FIXTURE_DETAILED)
		}),
	)

	it.effect("reports any other refusal as upstream", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			fake.failWith = () => "BillExpirationException"
			const error = yield* Effect.flip(pull(fake))
			assert.strictEqual(error.reason, "upstream")
			assert.strictEqual(error.requests, 1)
		}),
	)

	it.effect("fails the pull on an amount that is not a number", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			fake.items = [
				...FIXTURE_ITEMS,
				{
					day: "2026-02-28",
					service: "Invented Service",
					region: "us-east-1",
					usageType: "Invented-Usage",
					cost: Number.NaN,
					quantity: 1,
					unit: "Hrs",
				},
			]
			const error = yield* Effect.flip(pull(fake))
			assert.strictEqual(error.reason, "invalid_response")
			assert.strictEqual(error.requests, 1)
		}),
	)

	it.effect("gives up on a request AWS does not answer in 20 seconds", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			fake.beforeEachCall = Effect.never
			const fiber = yield* Effect.forkChild(Effect.flip(pull(fake)))
			yield* TestClock.adjust("21 seconds")
			const error = yield* Fiber.join(fiber)
			assert.strictEqual(error.reason, "upstream")
			assert.strictEqual(error.requests, 1)
		}),
	)

	it.effect("refuses a window that is not whole days in order, without asking AWS", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const error = yield* Effect.flip(pull(fake, { startDay: "2026-03-02", endDay: "2026-03-01" }))
			assert.strictEqual(error.reason, "upstream")
			assert.strictEqual(error.requests, 0)
			assert.lengthOf(fake.requests, 0)
		}),
	)
})
