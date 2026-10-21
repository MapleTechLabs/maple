import { OrgId } from "@maple/domain"
import { CloudflareIntegrationStatus } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as Menu from "../../../../ui/menu"
import { PageOutMessage, type PageContext } from "../../../contract"
import type { WorkerRow, ZoneRow } from "../data"
import { listDataOf, listScopeOf, phaseOf } from "./derive"
import { Message, type Model } from "./model"
import { ALL_ACCOUNTS, init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = 1_790_000_000_000

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const zone = (name: string, at: number) => ({
	id: name,
	name,
	enabled: true,
	lastSyncedAt: at,
	lastError: null,
	watermarkAt: at,
	backfillAt: null,
})

const account = (accountId: string, accountName: string, zones: ReadonlyArray<string>) => ({
	accountId,
	accountName,
	connectedByUserId: null,
	scope: "analytics:read",
	analyticsCapable: true,
	revoked: false,
	zones: zones.map((name) => zone(name, NOW - 60_000)),
	workers: null,
})

const status = (overrides: Readonly<Record<string, unknown>> = {}) =>
	Schema.decodeUnknownSync(CloudflareIntegrationStatus)({
		connected: true,
		accountId: "acc_a",
		accountName: "Acme",
		connectedByUserId: null,
		scope: null,
		analyticsCapable: true,
		connectedAt: NOW - 86_400_000,
		accounts: [account("acc_a", "Acme", ["acme.test"])],
		zones: [zone("acme.test", NOW - 60_000)],
		workers: null,
		...overrides,
	})

const zoneRow = (zoneName: string, requests: number): ZoneRow => ({
	serviceName: `cloudflare/${zoneName}`,
	zoneName,
	requests,
	errors5xx: 0,
	errorRate: 0,
	errors4xx: 0,
	clientErrorRate: 0,
	requests2xx: requests,
	requests3xx: 0,
	cacheHits: 0,
	cacheableRequests: 0,
	cacheHitRate: null,
	bytes: 0,
	visits: 0,
	ttfbP50Ms: 0,
	ttfbP95Ms: 0,
	ttfbP99Ms: 0,
	originP50Ms: 0,
	originP95Ms: 0,
	originP99Ms: 0,
})

const workerRow = (scriptName: string, accountId: string): WorkerRow => ({
	serviceName: `cloudflare-worker/${scriptName}`,
	accountId,
	scriptName,
	requests: 10,
	errors: 0,
	errorRate: 0,
	subrequests: 0,
	cpuP50Ms: 1,
	cpuP99Ms: 2,
	durationP50Ms: 3,
	durationP99Ms: 4,
})

const entered = (search: Model["search"] = {}) => {
	const model = init({ search }, context).model
	return pageUpdate(model, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })).model
}

const withStatus = (model: Model, value: CloudflareIntegrationStatus) =>
	pageUpdate(
		model,
		Message.CompletedLoadStatus({ key: model.status.key ?? "", result: Result.succeed(value) }),
	)

describe("cloudflare list", () => {
	test("entry asks for the status and usage; a connected, analytics-capable status loads the lists", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual(
			expect.arrayContaining([
				"ResolveCloudflareWindow",
				"LoadCloudflareIngestStatus",
				"LoadCloudflareUsage",
			]),
		)
		expect(names(withStatus(entered(), status()).commands)).toEqual(
			expect.arrayContaining([
				"FetchCloudflareZones",
				"FetchCloudflareZoneTimeseries",
				"FetchCloudflareWorkers",
				"FetchCloudflarePlatformResources",
			]),
		)
		expect(names(withStatus(entered(), status({ analyticsCapable: false })).commands)).toEqual([])
	})

	test("list state is patched into the URL in place", () => {
		const model = entered({ q: "acme", scope: "serving5xx" })
		expect(pageUpdate(model, Message.ClickedView({ view: "workers" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/cloudflare?view=workers", isReplace: true }),
		)
		expect(pageUpdate(entered(), Message.ToggledPreviews()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/cloudflare?previews=true", isReplace: true }),
		)
	})

	test("the account menu scopes to one account, and All accounts clears it", () => {
		const model = entered({ account: "acc_b", scope: "erroring" })
		const picked = pageUpdate(
			model,
			Message.GotAccountMenuMessage({
				message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Radio", value: ALL_ACCOUNTS } }),
			}),
		)
		expect(picked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/cloudflare", isReplace: true }),
		)
	})

	test("a multi-account grant filters by account and falls back to the first view with rows", () => {
		const multi = status({
			accounts: [account("acc_a", "Acme", ["acme.test"]), account("acc_b", "Beta", ["beta.test"])],
		})
		const loaded = [
			Message.CompletedFetchZones({ key: "", result: Result.succeed([zoneRow("acme.test", 5)]) }),
			Message.CompletedFetchWorkers({ key: "", result: Result.succeed([workerRow("api", "acc_b")]) }),
			Message.CompletedFetchPlatform({
				key: "",
				result: Result.succeed({ queues: [], durableObjects: [] }),
			}),
		].reduce(
			(model, message) => {
				const slot =
					message._tag === "CompletedFetchZones"
						? model.zones
						: message._tag === "CompletedFetchWorkers"
							? model.workers
							: model.platform
				return pageUpdate(model, { ...message, key: slot.key ?? "" }).model
			},
			withStatus(entered({ account: "acc_b" }), multi).model,
		)
		const scope = listScopeOf(loaded, listDataOf(loaded))
		expect(scope.counts).toEqual({ zones: 0, workers: 1, queues: 0 })
		expect(scope.view).toBe("workers")
		expect(scope.showAccountColumn).toBe(false)
	})

	test("a fresh connection with no zones listed yet is discovering", () => {
		const model = withStatus(entered(), status({ zones: [], accounts: [], connectedAt: NOW })).model
		expect(phaseOf(model)?.kind).toBe("discovering")
		expect(names(pageUpdate(model, Message.TickedIngestPoll()).commands)).toContain(
			"LoadCloudflareIngestStatus",
		)
	})
})
