import { OrgId } from "@maple/domain"
import {
	LinearIntegrationStatus,
	RailwayIntegrationStatus,
	SearchConsoleAvailableSitesResponse,
	SearchConsoleIntegrationStatus,
	SupabaseIntegrationStatus,
	VercelIntegrationStatus,
} from "@maple/domain/http"
import { V2ChatConnectorList, V2PlanetScaleIntegration, V2ScrapeTarget } from "@maple/domain/http/v2"
import { SupabaseProjectRef } from "@maple/primitives"
import { Array as Arr, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as Field from "@maple/views/ui/field"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { RailwayMessage } from "../infra-integrations/railway/integration/railway"
import { SupabaseMessage } from "../infra-integrations/supabase/integration/supabase"
import { ChatMessage } from "./chat"
import { cardStatusOf, overviewOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import {
	CHAT_PROVIDER,
	providerModuleOf,
	RAILWAY_PROVIDER,
	SUPABASE_PROVIDER,
	VERCEL_PROVIDER,
} from "./provider-modules"
import { SearchConsoleMessage } from "./search-console"
import { VercelMessage } from "../infra-integrations/vercel/integration/vercel"
import { PlanetscaleMessage } from "../infra-integrations/planetscale/integration/planetscale"
import { VERCEL_STATUS } from "../../lab/vercel-infra-fixtures"
import { init, update } from "./update"
import { receivedCallback, receivedRelay } from "./update-connect"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.parse("2026-10-01T12:00:00Z")
const REF = Schema.decodeSync(SupabaseProjectRef)("abcdefghijklmnopqrst")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const railway = (message: RailwayMessage) => Message.GotRailwayMessage({ message })
const supabase = (message: SupabaseMessage) => Message.GotSupabaseMessage({ message })
const chat = (message: ChatMessage) => Message.GotChatMessage({ message })
const searchConsole = (message: SearchConsoleMessage) => Message.GotSearchConsoleMessage({ message })
const vercel = (message: VercelMessage) => Message.GotVercelMessage({ message })
const planetscale = (message: PlanetscaleMessage) => Message.GotPlanetscaleMessage({ message })

const planetscaleStatus = (connected: boolean) =>
	Schema.decodeSync(V2PlanetScaleIntegration)({
		object: "planetscale_integration",
		connected,
		pending_org_selection: false,
		organization: connected ? "acme" : null,
		connected_by_user_id: null,
		detected_permissions: null,
		metrics_auth: "api",
		scrape_target: null,
		last_inventory_at: null,
		last_inventory_error: null,
		revoked_at: null,
		expires_at: null,
	})

const withVercel = (search: Model["search"], status: VercelIntegrationStatus, nowMs = NOW): Model => {
	const model = { ...init({ search }, context).model, nowMs }
	return pageUpdate(
		model,
		Message.CompletedLoadVercel({ key: model.statuses.vercel.key ?? "", result: Result.succeed(status) }),
	).model
}

const chatList = Schema.decodeSync(V2ChatConnectorList)({
	object: "chat_connector_list",
	data: [
		{
			id: "slack",
			object: "chat_connector",
			name: "Slack",
			available: true,
			supports_identity: true,
			workspaces: [
				{
					id: "chatw_YoxMqYdzUJ1tH4BqCWxPH3",
					object: "chat_workspace",
					connector: "slack",
					external_workspace_id: "T1",
					name: "Acme Shop",
					settings: {},
					created_at: "2026-09-10T12:00:00.000Z",
				},
			],
		},
	],
})

const withChat = (search: Model["search"]): Model => {
	const model = init({ search }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadChat({ key: model.statuses.chat.key ?? "", result: Result.succeed(chatList) }),
	).model
}

const searchConsoleStatus = (accountEmail: string) =>
	Schema.decodeSync(SearchConsoleIntegrationStatus)({
		configured: true,
		connected: true,
		accountEmail,
		connectedByUserId: null,
		revoked: false,
		sites: [],
	})

const SITES = Schema.decodeSync(SearchConsoleAvailableSitesResponse)({
	sites: [
		{ siteUrl: "sc-domain:acme.dev", permissionLevel: "siteOwner", selectable: true, enabled: false },
	],
})

const withSearchConsole = (accountEmail: string, model?: Model): Model => {
	const base = model ?? init({ search: { integration: "google-search-console" } }, context).model
	return pageUpdate(
		base,
		Message.CompletedLoadSearchConsole({
			key: base.statuses.searchConsole.key ?? "",
			result: Result.succeed(searchConsoleStatus(accountEmail)),
		}),
	).model
}

const railwayStatus = (firstSyncPending: boolean) =>
	Schema.decodeSync(RailwayIntegrationStatus)({
		connected: true,
		workspaceNames: "Acme",
		connectedByUserId: null,
		connectedAt: NOW,
		authFailed: false,
		lastSyncedAt: NOW,
		lastError: null,
		environments: [
			{
				projectId: "p1",
				projectName: "shop",
				environmentId: "e1",
				environmentName: "production",
				serviceCount: 3,
				enabled: true,
				lastSyncedAt: firstSyncPending ? null : NOW,
				lastError: null,
			},
		],
	})

const supabaseStatus = (connected: boolean) =>
	Schema.decodeSync(SupabaseIntegrationStatus)({
		configured: true,
		connected,
		organization: connected ? { id: "org-1", slug: "acme", name: "Acme" } : null,
		connectedByUserId: null,
		connectedAt: null,
		revoked: false,
		lastDiscoveryAt: null,
		lastDiscoveryError: null,
		projects: [],
	})

const withRailway = (search: Model["search"], status: RailwayIntegrationStatus): Model => {
	const model = init({ search }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadRailway({
			key: model.statuses.railway.key ?? "",
			result: Result.succeed(status),
		}),
	).model
}

const withSupabase = (search: Model["search"], status: SupabaseIntegrationStatus): Model => {
	const model = init({ search }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadSupabase({
			key: model.statuses.supabase.key ?? "",
			result: Result.succeed(status),
		}),
	).model
}

describe("provider modules", () => {
	test("a module's message changes only its own slot", () => {
		const model = init({ search: { integration: "railway" } }, context).model
		const next = pageUpdate(
			model,
			railway(
				RailwayMessage.GotTokenMessage({
					message: Field.Message.ChangedValue({ value: "rw_token" }),
				}),
			),
		).model
		expect(next.railwayCard.connect.token.value).toBe("rw_token")
		expect(next.supabaseCard).toBe(model.supabaseCard)
		expect(next.statuses).toBe(model.statuses)
		expect(next.connect).toBe(model.connect)
	})

	test("a module's hub requests run before its own commands", () => {
		const model = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		const toggled = pageUpdate(
			model,
			supabase(SupabaseMessage.ToggledSwitch({ ref: REF, kind: "logs", enabled: true })),
		)
		expect(names(toggled.commands)).toEqual(["SetSupabaseProjectLogs"])
		const saved = pageUpdate(
			toggled.model,
			supabase(
				SupabaseMessage.CompletedSwitch({ ref: REF, kind: "logs", enabled: true, failure: null }),
			),
		)
		const sent = names(saved.commands)
		expect(sent).toContain("ReadSupabaseClock")
		expect(sent.indexOf("LoadIntegrationsSupabaseStatus")).toBeLessThan(sent.indexOf("ReadSupabaseClock"))
		expect(sent.indexOf("LoadIntegrationsSupabaseStatus")).toBeGreaterThanOrEqual(0)
	})

	test("a module's toast request reaches the page as its OutMessage", () => {
		const model = withRailway({ integration: "railway" }, railwayStatus(false))
		const failure = toLoadFailure(new Error("down"))
		const failed = pageUpdate(model, railway(RailwayMessage.CompletedSync({ failure })))
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Couldn't sync Railway",
				description: failure.message,
			}),
		)
		expect(names(failed.commands)).toEqual([])
	})

	test("a clock reading the module took sets the page's clock", () => {
		const model = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		const read = pageUpdate(model, supabase(SupabaseMessage.CompletedReadClock({ nowMs: NOW })))
		expect(read.model.nowMs).toBe(NOW)
		expect(names(read.commands)).toEqual(["LoadIntegrationsSupabaseMetrics"])
	})

	test("Railway's first-sync poll runs only on its own card while an environment waits", () => {
		const ticker = RAILWAY_PROVIDER.ticker
		expect(ticker?.isActive(withRailway({ integration: "railway" }, railwayStatus(true)))).toBe(true)
		expect(ticker?.isActive(withRailway({ integration: "railway" }, railwayStatus(false)))).toBe(false)
		expect(ticker?.isActive(withRailway({}, railwayStatus(true)))).toBe(false)
	})

	test("Supabase's card clock ticks only while the connected card shows, and its tick reads the page clock", () => {
		const shown = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		const ticker = SUPABASE_PROVIDER.ticker
		expect(ticker?.isActive(shown)).toBe(true)
		expect(ticker?.isActive(withSupabase({ integration: "supabase" }, supabaseStatus(false)))).toBe(false)
		expect(ticker?.isActive(withSupabase({}, supabaseStatus(true)))).toBe(false)
		expect(ticker === null ? [] : names(pageUpdate(shown, ticker.tick).commands)).toEqual([
			"ReadIntegrationsClock",
		])
	})

	test("a successful connect runs the connected hook of that provider's module only", () => {
		const supabaseModel = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		expect(
			names(receivedCallback(supabaseModel, context, "supabase", "success", null).commands),
		).toContain("SyncSupabase")
		const linearModel = init({ search: { integration: "linear" } }, context).model
		expect(
			names(receivedCallback(linearModel, context, "linear", "success", null).commands),
		).not.toContain("SyncSupabase")
	})

	test("one module serves every chat connector's page, and only those", () => {
		expect(providerModuleOf("chat-slack")?.id).toBe("chat")
		expect(providerModuleOf("chat-discord")?.id).toBe("chat")
		expect(providerModuleOf("linear")?.id).toBe("linear")
		expect(providerModuleOf("github")).toBeUndefined()
		expect(providerModuleOf(null)).toBeUndefined()
	})

	test("a module drives the shared disconnect dialog and owns its confirm", () => {
		const model = withChat({ integration: "chat-slack" })
		const workspaceId = chatList.data[0]?.workspaces[0]?.id
		expect(workspaceId).toBeDefined()
		if (workspaceId === undefined) return
		const opened = pageUpdate(model, chat(ChatMessage.ClickedDisconnect({ workspaceId }))).model
		expect(opened.disconnect.dialog.isOpen).toBe(true)
		const confirmed = pageUpdate(opened, Message.ConfirmedDisconnect())
		expect(names(confirmed.commands)).toEqual(["DisconnectChatWorkspace"])
		// The module's removal is in flight: the dialog's own close is ignored.
		expect(CHAT_PROVIDER.isDisconnecting(confirmed.model)).toBe(true)
		const done = pageUpdate(confirmed.model, chat(ChatMessage.CompletedDisconnect({ failure: null })))
		expect(done.model.disconnect.dialog.isOpen).toBe(false)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Workspace disconnected",
				description: "",
			}),
		)
		const sent = names(done.commands)
		expect(sent.indexOf("LoadIntegrationsChatConnectors")).toBeGreaterThanOrEqual(0)
		expect(sent.indexOf("LoadIntegrationsChatConnectors")).toBeLessThan(
			sent.indexOf("TrackIntegrationDisconnected"),
		)
	})

	test("a status answer reaches the module with the read it replaced", () => {
		const first = withSearchConsole("owner@acme.dev")
		const listed = pageUpdate(
			first,
			searchConsole(
				SearchConsoleMessage.CompletedLoadSites({
					key: first.searchConsoleCard.sites.key ?? "",
					result: Result.succeed(SITES),
				}),
			),
		).model
		const picked = pageUpdate(
			listed,
			searchConsole(SearchConsoleMessage.ToggledSite({ siteUrl: "sc-domain:acme.dev" })),
		).model
		const reread: Model = {
			...picked,
			statuses: {
				...picked.statuses,
				searchConsole: { ...picked.statuses.searchConsole, key: "again" },
			},
		}
		// The same grant keeps the picker; another Google account starts it over.
		const sameAccount = withSearchConsole("owner@acme.dev", reread)
		expect(sameAccount.searchConsoleCard.draft).toEqual(["sc-domain:acme.dev"])
		expect(AsyncData.isSuccess(sameAccount.searchConsoleCard.sites.data)).toBe(true)
		const otherAccount = withSearchConsole("someone@globex.dev", reread)
		expect(otherAccount.searchConsoleCard.draft).toBeNull()
	})

	test("a connect another tab finished runs the relayed hook, not the connected one", () => {
		const model = withSearchConsole("owner@acme.dev")
		expect(
			names(receivedRelay(model, context, "google-search-console", "success", "").commands),
		).toContain("FetchSearchConsoleSites")
		const supabaseModel = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		expect(
			names(receivedRelay(supabaseModel, context, "supabase", "success", "").commands),
		).not.toContain("SyncSupabase")
	})

	test("Vercel's settle poll runs only on its own card while a fresh connection waits", () => {
		const settling = new VercelIntegrationStatus({
			...VERCEL_STATUS,
			connectedAt: NOW - 60_000,
			lastSuccessAt: null,
		})
		const ticker = VERCEL_PROVIDER.ticker
		expect(ticker?.isActive(withVercel({ integration: "vercel" }, settling))).toBe(true)
		expect(ticker?.isActive(withVercel({ integration: "vercel" }, VERCEL_STATUS))).toBe(false)
		expect(ticker?.isActive(withVercel({}, settling))).toBe(false)
		const shown = withVercel({ integration: "vercel" }, settling)
		// The tick re-reads the status, then the clock that ends the window.
		const sent = ticker === null ? [] : names(pageUpdate(shown, ticker.tick).commands)
		expect(sent.indexOf("LoadIntegrationsVercelStatus")).toBeGreaterThanOrEqual(0)
		expect(sent.indexOf("LoadIntegrationsVercelStatus")).toBeLessThan(
			sent.indexOf("ReadIntegrationsClock"),
		)
	})

	test("a module's own dialog stays in its slot, and closing it toasts before the re-read", () => {
		const model = withVercel({ integration: "vercel" }, VERCEL_STATUS)
		const opened = pageUpdate(model, vercel(VercelMessage.ClickedConfigure({ target: "token" }))).model
		expect(opened.vercelCard.configure?.target).toBe("token")
		expect(opened.disconnect).toBe(model.disconnect)
		const done = pageUpdate(
			opened,
			vercel(VercelMessage.CompletedConnect({ mode: "token", teamName: "Acme", error: null })),
		)
		expect(done.model.vercelCard.configure).toBeNull()
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Vercel token updated",
				description: "",
			}),
		)
		expect(names(done.commands)).toContain("LoadIntegrationsVercelStatus")
	})

	test("a module can re-read another of the hub's status reads", () => {
		const model = init({ search: { integration: "planetscale" } }, context).model
		const loaded = pageUpdate(
			model,
			Message.CompletedLoadPlanetscale({
				key: model.statuses.planetscale.key ?? "",
				result: Result.succeed(planetscaleStatus(true)),
			}),
		).model
		const saved = pageUpdate(loaded, planetscale(PlanetscaleMessage.CompletedToken({ failure: null })))
		const sent = names(saved.commands)
		expect(sent).toContain("LoadIntegrationsPlanetscaleStatus")
		expect(sent).toContain("LoadIntegrationsPlanetscaleDatabases")
		expect(saved.model.statuses.planetscaleDatabases.key).not.toBe(
			loaded.statuses.planetscaleDatabases.key,
		)
	})

	test("a module's header badge can read the hub's other statuses", () => {
		const model = init({ search: {} }, context).model
		const notConnected = pageUpdate(
			model,
			Message.CompletedLoadPlanetscale({
				key: model.statuses.planetscale.key ?? "",
				result: Result.succeed(planetscaleStatus(false)),
			}),
		).model
		const target = Schema.decodeSync(V2ScrapeTarget)({
			id: "scrp_YoxMqYdzUJ1tH4BqCWxPH3",
			object: "scrape_target",
			name: "acme",
			service_name: "planetscale",
			url: "https://api.planetscale.com/metrics",
			target_type: "planetscale",
			organization: "acme",
			include_branches: [],
			exclude_branches: [],
			scrape_interval_seconds: 60,
			labels_json: null,
			auth_type: "none",
			has_credentials: true,
			managed_by: null,
			enabled: true,
			last_scrape_at: null,
			last_scrape_error: null,
			created_at: "2026-09-01T00:00:00.000Z",
			updated_at: "2026-09-02T00:00:00.000Z",
		})
		const withTargets = pageUpdate(
			notConnected,
			Message.CompletedLoadScrapeTargets({
				key: notConnected.statuses.scrapeTargets.key ?? "",
				result: Result.succeed([target]),
			}),
		).model
		// Not connected through OAuth, the row counts its scrape targets instead.
		expect(cardStatusOf(withTargets.statuses, "planetscale", NOW)).toEqual({
			label: "1 org · 1 enabled",
			variant: "ok",
		})
	})

	test("the header badge and catalog row of a module come from the module", () => {
		const statuses = withRailway({}, railwayStatus(true)).statuses
		expect(cardStatusOf(statuses, "railway", NOW)).toEqual({ label: "1 environment", variant: "ok" })
		expect(overviewOf(statuses, NOW, "railway")).toMatchObject({
			kind: "connected",
			context: "Acme",
			stat: "1 environment polled",
		})
		const linear = init({ search: {} }, context).model
		const linearStatuses = pageUpdate(
			linear,
			Message.CompletedLoadLinear({
				key: linear.statuses.linear.key ?? "",
				result: Result.succeed(
					Schema.decodeSync(LinearIntegrationStatus)({
						connected: true,
						workspaceName: "Acme",
						connectedByUserId: null,
						revoked: true,
					}),
				),
			}),
		).model.statuses
		expect(cardStatusOf(linearStatuses, "linear", NOW)).toEqual({ label: "Revoked", variant: "warn" })
		// Chat rows read the one connector list by their own id.
		const chatStatuses = withChat({}).statuses
		expect(cardStatusOf(chatStatuses, "chat-slack", NOW)).toEqual({ label: "Acme Shop", variant: "ok" })
		expect(overviewOf(chatStatuses, NOW, "chat-slack")).toMatchObject({ context: "Acme Shop" })
	})
})
