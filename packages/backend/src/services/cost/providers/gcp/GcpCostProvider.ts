/**
 * Google Cloud as a cost provider: an org's Cloud Billing export to BigQuery, queried as the reader
 * account of the GCP connector the export was added through. Google has no API that answers cost.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { GcpConnectors, GcpCostExports } from "@maple/db/tables"
import { GcpServiceAccountKey } from "@maple/infra/secrets"
import { randomUUID } from "node:crypto"
import { Array as Arr, Clock, Context, Duration, Effect, Layer, Option, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import {
	fetchMapleAccessToken,
	type GcpApiError,
	type GcpReader,
	importServiceAccountKey,
	impersonateReader,
} from "../../../integrations/gcp/api"
import {
	type CostProviderAdapter,
	CostProviderError,
	type CostPull,
	type CostPullRow,
	type CostPullSource,
	type CostPullWindow,
} from "../../CostProvider"
import { monthStart, PREVIOUS_MONTH_OPEN_DAYS, utcToday } from "../../sync-plan"
import {
	costQuery,
	type GcpCostLine,
	type GcpQueryPage,
	getExportLayout,
	getQueryPage,
	lineOf,
	parseExportTable,
	startCostQuery,
} from "./bigquery"
import { rowsOf } from "./normalize"

/** Result rows one pull reads at most; past it the window is too large to store whole. */
export const MAX_RESULT_ROWS = 100_000
/** Calls that find the job still running before the pull gives up on it, about three minutes. */
export const MAX_WAITS = 18
const PULL_TIMEOUT = Duration.minutes(4)

type Reason = CostProviderError["reason"]

const failed = (reason: Reason, message: string, requests: number) =>
	new CostProviderError({ message, provider: "gcp", reason, requests })

/** Google's refusal, as what the sync does next and what the Cost page says to fix. */
const toProviderError = (error: GcpApiError, jobProject: string, requests: number): CostProviderError => {
	if (error.api === "Google OAuth") {
		return failed("auth", "Maple could not sign in to Google Cloud.", requests)
	}
	if (error.api === "IAM Credentials") {
		return error.kind === "denied" || error.kind === "not_found"
			? failed(
					"auth",
					"Maple could not act as the connection's reader account. Run the GCP connection's setup script again with Metrics and resources on.",
					requests,
				)
			: failed(error.kind === "rate_limited" ? "rate_limited" : "upstream", error.message, requests)
	}
	if (error.reason === "SERVICE_DISABLED") {
		return failed("not_ready", `Enable the BigQuery API in project ${jobProject}.`, requests)
	}
	if (error.reason === "RATE_LIMIT_EXCEEDED") {
		return failed(
			"rate_limited",
			"BigQuery is rate limiting or out of quota for the reader account.",
			requests,
		)
	}
	if (error.reason === "BILLING_DISABLED") {
		return failed(
			"not_ready",
			`Turn on billing for project ${jobProject}: BigQuery runs the cost query there.`,
			requests,
		)
	}
	if (error.reason === "BYTES_BILLED_LIMIT_EXCEEDED") {
		return failed(
			"too_large",
			"The billing export query would scan more than Maple allows in one run.",
			requests,
		)
	}
	switch (error.kind) {
		case "denied":
			return failed(
				"not_ready",
				`The reader account cannot query the billing export. Grant it BigQuery Data Viewer on the export table and BigQuery Job User on project ${jobProject}.`,
				requests,
			)
		case "not_found":
			return failed("not_ready", "BigQuery has no billing export table by that name.", requests)
		case "rate_limited":
			return failed("rate_limited", "BigQuery is rate limiting the reader account.", requests)
		case "invalid":
			return failed(
				"upstream",
				`BigQuery refused the billing export query (${error.message}).`,
				requests,
			)
		case "upstream":
			return failed("upstream", error.message, requests)
	}
}

/**
 * The first day Google may still restate: the open month, and the month before it until its
 * invoice closes early in the next one.
 */
export const openDayOf = (today: string): string =>
	monthStart(today, Number(Str.slice(8, 10)(today)) <= PREVIOUS_MONTH_OPEN_DAYS ? -1 : 0)

const isFiniteRow = (row: CostPullRow): boolean =>
	Arr.every([row.billedCost, row.effectiveCost, row.listCost, row.consumedQuantity], Number.isFinite)

export interface GcpCostProviderApi extends CostProviderAdapter {}

export class GcpCostProvider extends Context.Service<GcpCostProvider, GcpCostProviderApi>()(
	"@maple/backend/services/cost/GcpCostProvider",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const serviceAccountKey = yield* GcpServiceAccountKey
			const baseHttpClient = yield* HttpClient.HttpClient
			const dbExecute = makeDbExecute(database, "GcpCostProvider", () =>
				failed("upstream", "GCP cost export database error", 0),
			)

			const pull = Effect.fn("GcpCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "gcp",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					// By org as well as id: a source never reads through another org's connector.
					const [row] = yield* dbExecute((db) =>
						db.run(
							PG.from(GcpCostExports, "e")
								.innerJoin(GcpConnectors, "c", (exp, connector) =>
									connector.orgId.eq(exp.orgId).and(connector.id.eq(exp.connectorId)),
								)
								.select(($) => ({
									tableRef: $.tableRef,
									connectorId: $.c.id,
									projectId: $.c.projectId,
									metricsEnabled: $.c.metricsEnabled,
								}))
								.where(($) => [$.orgId.eq(source.orgId), $.id.eq(source.connectionRef)])
								.limit(1),
						),
					)
					if (row === undefined) {
						return yield* failed("auth", "No GCP billing export is saved for this source.", 0)
					}
					// The reader account exists only while the connector reads metrics and resources.
					if (!row.metricsEnabled) {
						return yield* failed(
							"not_ready",
							"Turn on Metrics and resources for the GCP connection: Maple reads the billing export as its reader account.",
							0,
						)
					}
					const table = parseExportTable(row.tableRef)
					if (Option.isNone(table)) {
						return yield* failed(
							"not_ready",
							"The saved billing export table id is not one Maple can read.",
							0,
						)
					}
					if (Option.isNone(serviceAccountKey)) {
						return yield* failed(
							"auth",
							"This deployment has no Google Cloud service account for Maple.",
							0,
						)
					}

					const requests = { count: 0 }
					const httpClient = baseHttpClient.pipe(
						HttpClient.tapRequest(() =>
							Effect.sync(() => {
								requests.count += 1
							}),
						),
					)
					const jobProject = row.projectId
					const now = yield* Clock.currentTimeMillis
					const lines = yield* Effect.gen(function* () {
						const signer = yield* importServiceAccountKey(serviceAccountKey.value)
						const mapleToken = yield* fetchMapleAccessToken(httpClient, signer, now)
						const reader = yield* impersonateReader(httpClient, mapleToken, {
							id: row.connectorId,
							projectId: row.projectId,
						})
						const layout = yield* getExportLayout(httpClient, reader, table.value)
						const first = yield* startCostQuery(
							httpClient,
							reader,
							jobProject,
							costQuery(table.value, layout),
							window,
							randomUUID(),
						)
						return yield* readAllPages(httpClient, reader, jobProject, first)
					}).pipe(
						Effect.mapError((error) =>
							error._tag === "@maple/backend/cost/CostProviderError"
								? failed(error.reason, error.message, requests.count)
								: toProviderError(error, jobProject, requests.count),
						),
						Effect.timeoutOrElse({
							duration: PULL_TIMEOUT,
							orElse: () =>
								Effect.fail(
									failed("upstream", "BigQuery took too long to answer.", requests.count),
								),
						}),
					)
					const rows = rowsOf(lines, openDayOf(utcToday(now)))
					if (!Arr.every(rows, isFiniteRow)) {
						return yield* failed(
							"invalid_response",
							"The billing export sums to no finite amount.",
							requests.count,
						)
					}
					yield* Effect.annotateCurrentSpan({
						"maple.cost.rows": rows.length,
						"maple.cost.gcp.lines": lines.length,
						"maple.cost.requests": requests.count,
					})
					return { rows, requests: requests.count } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			/**
			 * Every result page of the job, waiting for it while it runs. A result past
			 * `MAX_RESULT_ROWS` fails as too large rather than storing part of a day.
			 */
			const readAllPages = (
				httpClient: HttpClient.HttpClient,
				reader: GcpReader,
				jobProject: string,
				first: GcpQueryPage,
			) => {
				const step = (
					page: GcpQueryPage,
					lines: ReadonlyArray<GcpCostLine>,
					waits: number,
				): Effect.Effect<ReadonlyArray<GcpCostLine>, GcpApiError | CostProviderError> =>
					Effect.gen(function* () {
						const job = page.jobReference
						if (page.jobComplete !== true) {
							if (job === undefined || waits >= MAX_WAITS) {
								return yield* failed(
									"upstream",
									"The billing export query did not finish in time.",
									0,
								)
							}
							const next = yield* getQueryPage(httpClient, reader, jobProject, job, undefined)
							return yield* step(next, lines, waits + 1)
						}
						const all = Arr.appendAll(lines, Arr.map(page.rows ?? [], lineOf))
						if (all.length > MAX_RESULT_ROWS) {
							return yield* failed(
								"too_large",
								`The billing export answers more than ${MAX_RESULT_ROWS} rows for this window.`,
								0,
							)
						}
						if (page.pageToken === undefined || job === undefined) return all
						const next = yield* getQueryPage(httpClient, reader, jobProject, job, page.pageToken)
						return yield* step(next, all, waits)
					})
				return step(first, [], 0)
			}

			return { provider: "gcp", pull } satisfies GcpCostProviderApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
