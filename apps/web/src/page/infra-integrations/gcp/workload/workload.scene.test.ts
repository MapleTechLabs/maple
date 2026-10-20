import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
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
		expect(names(windowed("cloudRun", "checkout-api").commands)).toEqual([
			"FetchGcpWorkloadTimeseries",
			"FetchGcpWorkloadResource",
			"FetchGcpWorkloadServiceOverview",
		])
	})

	test("a Cloud SQL instance adds its inventory, statements, trace side and the fleet", () => {
		expect(names(windowed("cloudSql", "acme-shop-prod:orders-db").commands)).toEqual([
			"FetchGcpWorkloadSqlInventory",
			"FetchGcpCloudSqlTopQueries",
			"FetchGcpCloudSqlTraceSide",
			"FetchGcpWorkloadFleet",
			"FetchGcpWorkloadTimeseries",
			"FetchGcpWorkloadResource",
			"FetchGcpWorkloadServiceOverview",
		])
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
		expect(names(reloaded.commands)).toEqual([
			"ResolveGcpWorkloadWindow",
			"CompleteGcpWorkloadReloadSpin",
		])
		expect(
			pageUpdate(reloaded.model, Message.CompletedReloadSpin({ version: 0 })).model.isReloading,
		).toBe(true)
		expect(
			pageUpdate(reloaded.model, Message.CompletedReloadSpin({ version: 1 })).model.isReloading,
		).toBe(false)
	})
})
