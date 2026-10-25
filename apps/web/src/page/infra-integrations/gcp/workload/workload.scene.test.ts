import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import { PageOutMessage, type PageContext } from "../../../contract"
import { Message, type Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const search = { project: "acme-shop-prod", region: "us-central1" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const windowed = (service: string, name: string) =>
	pageUpdate(
		init({ service, name, search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	)

describe("gcp workload", () => {
	test("a Cloud Run service reads its metrics, inventory row and the traced services", () => {
		const cloudRun = names(windowed("cloudRun", "checkout-api").commands)
		expect(cloudRun).toEqual(
			expect.arrayContaining([
				"FetchGcpWorkloadTimeseries",
				"FetchGcpWorkloadResource",
				"FetchGcpWorkloadServiceOverview",
			]),
		)
		expect(cloudRun).not.toContain("FetchGcpCloudSqlTopQueries")
	})

	test("a Cloud SQL instance adds its inventory, statements, trace side and the fleet", () => {
		expect(names(windowed("cloudSql", "acme-shop-prod:orders-db").commands)).toEqual(
			expect.arrayContaining([
				"FetchGcpWorkloadSqlInventory",
				"FetchGcpCloudSqlTopQueries",
				"FetchGcpCloudSqlTraceSide",
				"FetchGcpWorkloadFleet",
			]),
		)
	})

	test("a GKE container also reads its cluster's nodes", () => {
		expect(names(windowed("gke", "checkout").commands)).toContain("FetchGcpClusterNodes")
	})

	test("an unknown service replaces the URL with the Google Cloud list", () => {
		const entered = init({ service: "nope", name: "x", search }, context)
		expect(entered.commands).toBeUndefined()
		expect(entered.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/gcp", isReplace: true }),
		)
	})

	test("show all toggles the statement list; reset returns to the default window", () => {
		const model = windowed("cloudSql", "acme-shop-prod:orders-db").model
		const shown = pageUpdate(model, Message.ClickedShowAllQueries()).model
		expect(shown.showAllQueries).toBe(true)
		expect(pageUpdate(shown, Message.ClickedShowAllQueries()).model.showAllQueries).toBe(false)
		const reset = pageUpdate(
			init(
				{ service: "cloudRun", name: "checkout-api", search: { ...search, timePreset: "1d" } },
				context,
			).model,
			Message.ClickedResetTimeRange(),
		)
		expect(reset.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/gcp/cloudRun/checkout-api?project=acme-shop-prod&region=us-central1&timePreset=1h",
				isReplace: false,
			}),
		)
	})

	test("reload re-asks the window in refresh mode and spins until its version completes", () => {
		const model = windowed("cloudRun", "checkout-api").model
		const reloaded = pageUpdate(model, Message.ClickedReload())
		expect(reloaded.model.isReloading).toBe(true)
		expect(names(reloaded.commands)).toEqual(
			expect.arrayContaining(["ResolveGcpWorkloadWindow", "CompleteGcpWorkloadReloadSpin"]),
		)
		expect(
			pageUpdate(reloaded.model, Message.CompletedReloadSpin({ version: 0 })).model.isReloading,
		).toBe(true)
		expect(
			pageUpdate(reloaded.model, Message.CompletedReloadSpin({ version: 1 })).model.isReloading,
		).toBe(false)
	})

	describe("query peek", () => {
		const instance = "acme-shop-prod:orders-db"
		const statement = (queryHash: string, text: string) => ({
			queryHash,
			statement: text,
			calls: 1200,
			executionSeconds: 40,
			lockSeconds: 1,
			ioSeconds: 2,
			rowCount: 1200,
			p50Seconds: 0.01,
			p95Seconds: 0.04,
		})
		const traceSide = {
			databases: ["orders"],
			services: 1,
			tracedQueries: [
				{
					queryKey: "1449",
					sampleStatement: "UPDATE orders SET status = 'paid' WHERE id = 7",
					sampleService: "checkout-api",
					serviceCount: 1,
					estimatedQueryCount: 1200,
					p95DurationMs: 410,
				},
			],
		}
		/** The instance with `peek` in the URL, its statements and trace side read. */
		const peeked = (peek: string) => {
			const loaded = pageUpdate(
				init({ service: "cloudSql", name: instance, search: { ...search, peek } }, context).model,
				Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
			).model
			const withRows = pageUpdate(
				loaded,
				Message.CompletedFetchTopQueries({
					key: loaded.topQueries.key ?? "",
					result: Result.succeed([
						statement("a", "UPDATE orders SET status = $1 WHERE id = $2"),
						statement("b", "SELECT count(*) FROM orders WHERE created_at > $1"),
					]),
				}),
			).model
			return pageUpdate(
				withRows,
				Message.CompletedFetchTraceSide({
					key: withRows.traceSide.key ?? "",
					result: Result.succeed(traceSide),
				}),
			)
		}

		test("a statement click puts its hash in the URL", () => {
			const model = windowed("cloudSql", instance).model
			expect(pageUpdate(model, Message.ClickedStatement({ queryHash: "a" })).outMessage).toEqual(
				PageOutMessage.RequestedNavigation({
					url: `/infra/gcp/cloudSql/${encodeURIComponent(instance)}?project=acme-shop-prod&region=us-central1&peek=a`,
					isReplace: false,
				}),
			)
		})

		test("a peeked traced statement opens the sheet and reads its slowest spans", () => {
			const opened = peeked("a")
			expect(opened.model.queryPeek.isOpen).toBe(true)
			expect(names(opened.commands)).toContain("FetchGcpCloudSqlStatementSpans")
		})

		test("a peeked statement the traces never recorded opens without a spans read", () => {
			const opened = peeked("b")
			expect(opened.model.queryPeek.isOpen).toBe(true)
			expect(names(opened.commands)).not.toContain("FetchGcpCloudSqlStatementSpans")
		})

		test("a hash no statement has keeps the sheet closed", () => {
			expect(peeked("gone").model.queryPeek.isOpen).toBe(false)
		})

		test("retrying failed calls asks for them again", () => {
			const opened = peeked("a")
			const failed = pageUpdate(
				opened.model,
				Message.CompletedFetchStatementSpans({
					key: opened.model.statementSpans.key ?? "",
					result: Result.fail(toLoadFailure("timed out")),
				}),
			).model
			const retried = pageUpdate(failed, Message.ClickedRetryStatementSpans())
			expect(names(retried.commands)).toEqual(["FetchGcpCloudSqlStatementSpans"])
		})

		test("another statement's calls are not shown under the one now peeked", () => {
			const opened = peeked("a")
			const answered = pageUpdate(
				opened.model,
				Message.CompletedFetchStatementSpans({
					key: opened.model.statementSpans.key ?? "",
					result: Result.succeed([
						{
							traceId: "t",
							spanId: "s",
							serviceName: "checkout-api",
							timestamp: "2026-10-01T11:30:00Z",
							durationMs: 900,
						},
					]),
				}),
			).model
			const otherWindow = pageUpdate(
				answered,
				Message.CompletedResolveWindow({
					window: { startTime: "2026-10-01 10:00:00", endTime: "2026-10-01 12:00:00" },
					nowMs: 0,
					mode: "Load",
				}),
			).model
			expect(otherWindow.statementSpans.data._tag).toBe("Loading")
		})

		test("escape closes the sheet and drops the peek from the URL in place", () => {
			const closed = pageUpdate(
				peeked("a").model,
				Message.GotQueryPeekMessage({ message: Dialog.Message.PressedEscape() }),
			)
			expect(closed.outMessage).toEqual(
				PageOutMessage.RequestedNavigation({
					url: `/infra/gcp/cloudSql/${encodeURIComponent(instance)}?project=acme-shop-prod&region=us-central1`,
					isReplace: true,
				}),
			)
		})
	})
})
