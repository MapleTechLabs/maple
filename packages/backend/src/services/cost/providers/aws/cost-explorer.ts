/**
 * The Cost Explorer side of an AWS cost pull: one `SERVICE` x `REGION` query finds the regions worth
 * detail, then one `SERVICE` x `USAGE_TYPE` query per such region, filtered on it (Cost Explorer
 * takes two GroupBy keys at most). Owns the SDK import, so `AwsCostProvider` loads it lazily.
 */
import * as Category from "@distilled.cloud/aws/Category"
import * as CE from "@distilled.cloud/aws/cost-explorer"
import * as Credentials from "@distilled.cloud/aws/Credentials"
import { UnknownAwsError } from "@distilled.cloud/aws/Errors"
import * as Retry from "@distilled.cloud/aws/Retry"
import { Duration, Effect, Option, Ref, Result, Array as Arr, String as Str } from "effect"
import { HttpClient } from "effect/http"
import type { AwsRoleSession } from "../../../integrations/aws/api"
import { type CostPullRow, type CostPullWindow, CostProviderError } from "../../CostProvider"
import {
	type CostExplorerResult,
	costExplorerPeriod,
	detailedRegions,
	parseGroups,
	serviceRows,
	usageRows,
} from "./normalize"

const REQUEST_TIMEOUT = Duration.seconds(20)
// A page holds 2,500 groups and costs the account owner USD 0.01: a token that loops stops here.
const MAX_PAGES = 200
const METRICS = ["UnblendedCost", "AmortizedCost", "UsageQuantity"]

// The SDK's default patience (8 retries, about 20s) outlasts the timeout, and a retry is a request.
const RETRY: Retry.Options = {
	while: Category.isTransientError,
	backoff: { baseMs: 500, factor: 2, capMs: 2000, maxRetries: 2, jitterMs: 50 },
}

const THROTTLE_CODES = new Set(["LimitExceededException", "ThrottlingException", "Throttling"])
// The role lacks the cost policy, or Cost Explorer has no data for the account yet.
const NOT_READY_CODES = new Set(["AccessDeniedException", "DataUnavailableException"])

type Reason = CostProviderError["reason"]

const codeOf = (error: { readonly _tag: string }) =>
	error instanceof UnknownAwsError ? error.errorTag : error._tag

const reasonOf = (error: { readonly _tag: string }): Reason => {
	const code = codeOf(error)
	if (THROTTLE_CODES.has(code) || Category.isThrottling(error)) return "rate_limited"
	return NOT_READY_CODES.has(code) ? "not_ready" : "upstream"
}

const messageOf = (error: { readonly _tag: string }) => {
	const detail =
		"message" in error && typeof error.message === "string" ? Str.slice(0, 200)(error.message) : ""
	return `GetCostAndUsage: ${detail === "" ? codeOf(error) : detail}`
}

export interface CostExplorerPull {
	readonly rows: ReadonlyArray<CostPullRow>
	/** Every request sent to Cost Explorer, retries and the failed ones included. */
	readonly requests: number
	readonly detailedRegions: ReadonlyArray<string>
}

/**
 * Every row of every day of `window`, read with `session`. One request at a time: a Worker has six
 * connections. A failure carries the requests sent before it.
 */
export const pullCostExplorer = (
	httpClient: HttpClient.HttpClient,
	session: AwsRoleSession,
	accountId: string,
	window: CostPullWindow,
): Effect.Effect<CostExplorerPull, CostProviderError> =>
	Effect.gen(function* () {
		const sent = yield* Ref.make(0)
		const fail = (reason: Reason, message: string) =>
			Effect.flatMap(Ref.get(sent), (requests) =>
				Effect.fail(new CostProviderError({ message, provider: "aws", reason, requests })),
			)
		const counting = HttpClient.mapRequestEffect(httpClient, (request) =>
			Effect.as(
				Ref.update(sent, (count) => count + 1),
				request,
			),
		)
		// A policy the caller installed wins, so a test can run without the backoff sleeps.
		const installed = yield* Effect.serviceOption(Retry.Retry)
		const retry = Option.getOrElse(installed, () => RETRY)

		const query = (input: CE.GetCostAndUsageRequest) =>
			CE.getCostAndUsage(input).pipe(
				Effect.provideService(Retry.Retry, retry),
				Effect.provideService(Credentials.Credentials, session.credentials),
				Effect.provideService(HttpClient.HttpClient, counting),
				Effect.catch((error) => fail(reasonOf(error), messageOf(error))),
				Effect.timeoutOrElse({
					duration: REQUEST_TIMEOUT,
					orElse: () => fail("upstream", "GetCostAndUsage: AWS did not answer in time"),
				}),
			)

		const pages = (
			input: CE.GetCostAndUsageRequest,
			seen: ReadonlyArray<CostExplorerResult>,
			page: number,
		): Effect.Effect<ReadonlyArray<CostExplorerResult>, CostProviderError> =>
			Effect.flatMap(query(input), (answer) => {
				const results = Arr.appendAll(seen, answer.ResultsByTime ?? [])
				const next = answer.NextPageToken
				if (next === undefined || next === "") return Effect.succeed(results)
				return page >= MAX_PAGES
					? fail("upstream", "GetCostAndUsage: more pages than a pull reads")
					: pages({ ...input, NextPageToken: next }, results, page + 1)
			})

		const groupsOf = (input: CE.GetCostAndUsageRequest) =>
			Effect.flatMap(pages(input, [], 1), (results) =>
				Result.match(parseGroups(results), {
					onFailure: (message) => fail("invalid_response", `GetCostAndUsage: ${message}`),
					onSuccess: (groups) => Effect.succeed(groups),
				}),
			)

		const period = costExplorerPeriod(window)
		if (Option.isNone(period)) {
			return yield* fail("upstream", `Not a window of days: ${window.startDay} to ${window.endDay}`)
		}
		const base = {
			TimePeriod: { Start: period.value.Start, End: period.value.End },
			Granularity: "DAILY",
			Metrics: METRICS,
		} satisfies Partial<CE.GetCostAndUsageRequest>

		const byRegion = yield* groupsOf({
			...base,
			GroupBy: [
				{ Type: "DIMENSION", Key: "SERVICE" },
				{ Type: "DIMENSION", Key: "REGION" },
			],
		})
		const regions = detailedRegions(byRegion, period.value.days)
		const detailed = yield* Effect.forEach(regions, (region) =>
			Effect.map(
				groupsOf({
					...base,
					GroupBy: [
						{ Type: "DIMENSION", Key: "SERVICE" },
						{ Type: "DIMENSION", Key: "USAGE_TYPE" },
					],
					Filter: { Dimensions: { Key: "REGION", Values: [region] } },
				}),
				(groups) => usageRows(groups, accountId, region),
			),
		)
		const requests = yield* Ref.get(sent)
		return {
			rows: Arr.appendAll(Arr.flatten(detailed), serviceRows(byRegion, accountId, regions)),
			requests,
			detailedRegions: regions,
		}
	})
