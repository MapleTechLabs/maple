import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2GcpIntegration } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../../data/load-failure"
import * as Menu from "../../../../ui/menu"
import { PageOutMessage, type PageContext } from "../../../contract"
import type { FleetRead } from "../data"
import { Message, type Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = 1_790_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const status = (connected: boolean, overrides: Readonly<Record<string, unknown>> = {}) =>
	Schema.decodeUnknownSync(V2GcpIntegration)({
		object: "gcp_integration",
		metrics_available: true,
		connectors: connected
			? [
					{
						id: encodePublicId(
							PublicIdPrefixes.gcpConnector,
							"00000000-0000-4000-8000-000000000002",
						),
						object: "gcp_connector",
						scope_type: "project",
						scope_id: "acme-prod",
						project_id: "acme-prod",
						logs_enabled: true,
						metrics_enabled: true,
						created_at: iso(NOW - 86_400_000),
						last_log_received_at: iso(NOW - 60_000),
						last_log_error: null,
						applied_logs_enabled: true,
						applied_metrics_enabled: true,
						setup_reported_at: iso(NOW - 86_000_000),
						last_metrics_received_at: iso(NOW - 60_000),
						last_metrics_error: null,
						discovered_project_count: 1,
						last_resources_error: null,
						...overrides,
					},
				]
			: [],
	})

const fleet: ReadonlyArray<FleetRead> = [
	{
		service: "cloudRun",
		points: [
			{
				keys: ["checkout-api", "acme-prod", "us-central1"],
				metric: "run.googleapis.com/request_count",
				label: "2xx",
				total: 10,
				samples: 1,
			},
		],
		failed: false,
	},
]

const withStatus = (connected: boolean) => {
	const entered = init({ search: {} }, context).model
	const windowed = pageUpdate(
		entered,
		Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "de-DE", mode: "Load" }),
	).model
	return pageUpdate(
		windowed,
		Message.CompletedLoadStatus({
			key: windowed.status.key ?? "",
			result: Result.succeed(status(connected)),
		}),
	)
}

describe("google cloud list", () => {
	test("after a Reload a tab change reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(withStatus(true).model, Message.ClickedReload()).model
		const tabbed = routeChanged(reloaded, { search: { tab: "resources" } }, context)
		expect(names(tabbed.commands)).not.toContain("ResolveGcpWindow")
		expect(tabbed.model.window).toEqual(window)
		const moved = routeChanged(tabbed.model, { search: { tab: "resources", timePreset: "6h" } }, context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])?.[0]).toEqual([
			"ResolveGcpWindow",
			"Refresh",
		])
	})

	test("a connected status reads the fleet and nothing else until it lands", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual(
			expect.arrayContaining(["ResolveGcpWindow", "LoadGcpStatus", "LoadChartRuntime"]),
		)
		expect(names(withStatus(true).commands)).toEqual(["FetchGcpFleet"])
	})

	test("the window read carries the browser locale the tables format counts with", () => {
		expect(withStatus(true).model.locale).toBe("de-DE")
	})

	test("an org with no connection reads nothing more", () => {
		expect(names(withStatus(false).commands)).toEqual([])
	})

	test("the landed fleet picks the services view and reads its sparklines", () => {
		const model = withStatus(true).model
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchFleet({ key: model.fleet.key ?? "", result: Result.succeed(fleet) }),
		)
		expect(names(loaded.commands)).toEqual(["FetchGcpSparklines"])
	})

	test("a failed fleet read is not retried until asked", () => {
		const model = withStatus(true).model
		const failed = pageUpdate(
			model,
			Message.CompletedFetchFleet({
				key: model.fleet.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		)
		expect(names(failed.commands)).toEqual([])
		expect(names(pageUpdate(failed.model, Message.ClickedRetryFleet()).commands)).toEqual([
			"FetchGcpFleet",
		])
	})

	test("a view switch writes ?view= and drops the old ?tab=, scope and search", () => {
		const model = init({ search: { tab: "cloudRun", scope: "slow", q: "x" } }, context).model
		expect(pageUpdate(model, Message.ClickedView({ view: "cloudSql" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/gcp?view=cloudSql", isReplace: false }),
		)
	})

	test("a project picked in the title menu closes it and writes ?project=, dropping the scope", () => {
		const model = init({ search: { scope: "slow" } }, context).model
		const opened = pageUpdate(
			model,
			Message.GotProjectMenuMessage({ message: Menu.Message.ClickedTrigger() }),
		)
		const picked = pageUpdate(
			opened.model,
			Message.GotProjectMenuMessage({
				message: Menu.Message.ClickedItem({ index: 2, item: { kind: "Radio", value: "acme-data" } }),
			}),
		)
		expect(picked.model.projectMenu.isOpen).toBe(false)
		expect(picked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/gcp?project=acme-data", isReplace: false }),
		)
	})

	test("the live clock ages a connector out of settling, so the 10 s poll stops", () => {
		// Read access just confirmed, nothing read yet and an error: waiting, then failing past the grace.
		const waiting = status(true, {
			setup_reported_at: iso(NOW - 60_000),
			last_metrics_received_at: null,
			last_metrics_error: "permission denied",
		})
		const windowed = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "en-US", mode: "Load" }),
		).model
		const model = pageUpdate(
			windowed,
			Message.CompletedLoadStatus({ key: windowed.status.key ?? "", result: Result.succeed(waiting) }),
		).model
		const deps = (next: Model) => ({
			clock: subscriptions.liveClock.modelToDependencies({ model: next, context }),
			cadence: subscriptions.statusRefresh.modelToDependencies({ model: next, context }),
		})
		expect(deps(model)).toEqual({ clock: { hasStatus: true }, cadence: { cadence: "settling" } })
		const aged = pageUpdate(model, Message.TickedLiveClock({ nowMs: NOW + 11 * 60_000 })).model
		expect(deps(aged).cadence).toEqual({ cadence: "steady" })
	})
})
