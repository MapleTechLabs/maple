/**
 * A small Cost Explorer for tests: `GetCostAndUsage` answered from synthetic line items, grouped,
 * filtered and paged the way AWS does it, so a test proves the requests a pull sends are the ones
 * that add up. Calls to anything else go to `fallback` (the fake STS).
 */
import { Effect, Number as Num, Option, Order, Schema, Array as Arr, String as Str } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { timestampMs } from "@maple/backend/platform/time"
import type { CostExplorerResult } from "./normalize"

/** One invented charge: a day's use of one usage type of a service in a region. */
export interface FakeCostItem {
	readonly day: string
	readonly service: string
	readonly region: string
	readonly usageType: string
	readonly cost: number
	/** Defaults to `cost`. */
	readonly amortized?: number
	readonly quantity: number
	readonly unit: string
}

const FakeCostRequest = Schema.Struct({
	TimePeriod: Schema.Struct({ Start: Schema.String, End: Schema.String }),
	Granularity: Schema.String,
	Metrics: Schema.Array(Schema.String),
	GroupBy: Schema.Array(Schema.Struct({ Type: Schema.String, Key: Schema.String })),
	Filter: Schema.optionalKey(
		Schema.Struct({
			Dimensions: Schema.Struct({ Key: Schema.String, Values: Schema.Array(Schema.String) }),
		}),
	),
	NextPageToken: Schema.optionalKey(Schema.String),
})
export type FakeCostRequest = typeof FakeCostRequest.Type

export interface FakeCostAnswer {
	readonly ResultsByTime: ReadonlyArray<CostExplorerResult>
	readonly NextPageToken?: string
}

export interface FakeCostOptions {
	/** Groups per page. AWS pages at 2,500. */
	readonly pageSize?: number
	/** Days from this one on are still estimated, as the open month is. */
	readonly estimatedFrom?: string
}

// Sums of decimal fractions, printed the way AWS prints them: without the float tail.
const amount = (values: ReadonlyArray<number>) => String(Math.round(Num.sumAll(values) * 1e10) / 1e10)

const nextDay = (day: string) =>
	Str.slice(0, 10)(new Date(timestampMs(`${day}T00:00:00Z`) + 86_400_000).toISOString())

const dimensionOf = (item: FakeCostItem, key: string) =>
	key === "SERVICE" ? item.service : key === "REGION" ? item.region : item.usageType

/** What AWS answers `request` with for an account whose charges are `items`. A day without groups is left out. */
export const answerCostExplorer = (
	items: ReadonlyArray<FakeCostItem>,
	request: FakeCostRequest,
	options: FakeCostOptions = {},
): FakeCostAnswer => {
	const pageSize = options.pageSize ?? 2500
	const [first, second] = request.GroupBy
	const filter = request.Filter?.Dimensions
	const matching = Arr.filter(
		items,
		(item) =>
			item.day >= request.TimePeriod.Start &&
			item.day < request.TimePeriod.End &&
			(filter === undefined || Arr.contains(filter.Values, dimensionOf(item, filter.Key))),
	)
	const keysOf = (item: FakeCostItem) => [
		dimensionOf(item, first?.Key ?? "SERVICE"),
		dimensionOf(item, second?.Key ?? "REGION"),
	]
	const idOf = (item: FakeCostItem) => Arr.join([item.day, ...keysOf(item)], "\u0000")
	const groups = Arr.map(Arr.sort(Arr.dedupe(Arr.map(matching, idOf)), Order.String), (id) => {
		const members = Arr.filter(matching, (item) => idOf(item) === id)
		const [head] = members
		const units = Arr.dedupe(Arr.map(members, (item) => item.unit))
		return {
			day: head?.day ?? "",
			group: {
				Keys: head === undefined ? [] : keysOf(head),
				Metrics: {
					AmortizedCost: {
						Amount: amount(Arr.map(members, (item) => item.amortized ?? item.cost)),
						Unit: "USD",
					},
					UnblendedCost: { Amount: amount(Arr.map(members, (item) => item.cost)), Unit: "USD" },
					UsageQuantity: {
						Amount: amount(Arr.map(members, (item) => item.quantity)),
						// A group that mixes units has none.
						Unit: units.length === 1 ? (units[0] ?? "N/A") : "N/A",
					},
				},
			},
		}
	})
	const offset =
		request.NextPageToken === undefined ? 0 : Number(Str.replace("page-", "")(request.NextPageToken))
	const page = Arr.take(Arr.drop(groups, offset), pageSize)
	const days = Arr.dedupe(Arr.map(page, (entry) => entry.day))
	const results = Arr.map(days, (day) => ({
		TimePeriod: { Start: day, End: nextDay(day) },
		Estimated: options.estimatedFrom !== undefined && day >= options.estimatedFrom,
		Groups: Arr.map(
			Arr.filter(page, (entry) => entry.day === day),
			(entry) => entry.group,
		),
	}))
	return offset + pageSize < groups.length
		? { ResultsByTime: results, NextPageToken: `page-${offset + pageSize}` }
		: { ResultsByTime: results }
}

export interface FakeCostExplorer {
	readonly client: HttpClient.HttpClient
	/** Every `GetCostAndUsage` request received, in order, the refused ones included. */
	readonly requests: Array<FakeCostRequest>
	items: ReadonlyArray<FakeCostItem>
	options: FakeCostOptions
	/** Runs before every answer: a test makes AWS slow with it. */
	beforeEachCall: Effect.Effect<void>
	/** The error type to refuse a request with, as AWS does: HTTP 400 and a `__type`. */
	failWith: (request: FakeCostRequest, index: number) => string | undefined
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(FakeCostRequest))
const decoder = new TextDecoder()

const CE_URL = "https://ce.us-east-1.amazonaws.com/"
const CE_TARGET = "AWSInsightsIndexService.GetCostAndUsage"

export const makeFakeCostExplorer = (
	fallback: HttpClient.HttpClient,
	items: ReadonlyArray<FakeCostItem> = [],
): FakeCostExplorer => {
	const state: FakeCostExplorer = {
		requests: [],
		items,
		options: {},
		beforeEachCall: Effect.void,
		failWith: () => undefined,
		client: HttpClient.make((request) => {
			if (request.headers["x-amz-target"] !== CE_TARGET || request.url !== CE_URL) {
				return fallback.execute(request)
			}
			const json = (status: number, body: unknown) =>
				HttpClientResponse.fromWeb(
					request,
					new Response(encodeJson(body), {
						status,
						headers: { "content-type": "application/x-amz-json-1.1" },
					}),
				)
			const refuse = (type: string, message: string) => json(400, { __type: type, message })
			return Effect.suspend(() => state.beforeEachCall).pipe(
				Effect.map(() => {
					// Signed for Cost Explorer with a session: an assumed role's key and its token.
					const signed =
						/Credential=ASIA[^/]*\/\d{8}\/us-east-1\/ce\/aws4_request/u.test(
							request.headers["authorization"] ?? "",
						) && request.headers["x-amz-security-token"] !== undefined
					if (!signed) {
						return refuse("UnrecognizedClientException", "The security token is invalid.")
					}
					const decoded = decodeRequest(
						request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : "",
					)
					if (Option.isNone(decoded)) return refuse("ValidationException", "Malformed request")
					const index = state.requests.push(decoded.value) - 1
					const failure = state.failWith(decoded.value, index)
					if (failure !== undefined) return refuse(failure, `fake ${failure}`)
					if (decoded.value.GroupBy.length > 2) {
						return refuse("ValidationException", "Only two values for GroupBy are allowed")
					}
					return json(200, answerCostExplorer(state.items, decoded.value, state.options))
				}),
			)
		}),
	}
	return state
}
