import { OrgId } from "@maple/domain"
import {
	LinearIntegrationStatus,
	RailwayIntegrationStatus,
	SearchConsoleAvailableSitesResponse,
	SearchConsoleIntegrationStatus,
	SupabaseIntegrationStatus,
	VercelIntegrationStatus,
	CloudflareUsageResponse,
	GithubInstallationSelection,
} from "@maple/domain/http"
import {
	encodePublicId,
	PublicIdPrefixes,
	Timestamp,
	type V2AwsConnection,
	V2ChatConnectorList,
	V2GcpIntegration,
	V2PlanetScaleIntegration,
	V2ScrapeTarget,
} from "@maple/domain/http/v2"
import { AwsMetricStream } from "@maple/domain/aws"
import { AwsAccountId, AwsConnectionId, SupabaseProjectRef } from "@maple/primitives"
import { Array as Arr, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Menu from "@maple/views/ui/menu"
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
	AWS_PROVIDER,
	CHAT_PROVIDER,
	GCP_PROVIDER,
	GITHUB_PROVIDER,
	PROMETHEUS_PROVIDER,
	providerModuleOf,
	RAILWAY_PROVIDER,
	SUPABASE_PROVIDER,
	VERCEL_PROVIDER,
} from "./provider-modules"
import { SearchConsoleMessage } from "./search-console"
import { VercelMessage } from "../infra-integrations/vercel/integration/vercel"
import { PlanetscaleMessage } from "../infra-integrations/planetscale/integration/planetscale"
import { CloudflareMessage } from "../infra-integrations/cloudflare/integration/cloudflare"
import { VERCEL_STATUS } from "../../lab/vercel-infra-fixtures"
import { init, update } from "./update"
import { clickedConnect, closedPopup, receivedCallback, receivedRelay } from "./update-connect"
import { GithubMessage } from "./github"
import { PrometheusMessage } from "./prometheus"
import { AwsMessage } from "../infra-integrations/aws/integration/aws"
import { GcpMessage } from "../infra-integrations/gcp/integration/gcp"
import { view as pageView } from "./view"

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
const scrape = (message: PrometheusMessage) => Message.GotPrometheusMessage({ message })
const aws = (message: AwsMessage) => Message.GotAwsMessage({ message })
const gcp = (message: GcpMessage) => Message.GotGcpMessage({ message })

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
					alerts_enabled: true,
					direct_messages_enabled: true,
					assistant_enabled: true,
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
		const ticker = RAILWAY_PROVIDER.tickers[0]
		expect(ticker?.isActive(withRailway({ integration: "railway" }, railwayStatus(true)))).toBe(true)
		expect(ticker?.isActive(withRailway({ integration: "railway" }, railwayStatus(false)))).toBe(false)
		expect(ticker?.isActive(withRailway({}, railwayStatus(true)))).toBe(false)
	})

	test("Supabase's card clock ticks only while the connected card shows, and its tick reads the page clock", () => {
		const shown = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		const ticker = SUPABASE_PROVIDER.tickers[0]
		expect(ticker?.isActive(shown)).toBe(true)
		expect(ticker?.isActive(withSupabase({ integration: "supabase" }, supabaseStatus(false)))).toBe(false)
		expect(ticker?.isActive(withSupabase({}, supabaseStatus(true)))).toBe(false)
		expect(ticker === undefined ? [] : names(pageUpdate(shown, ticker.tick).commands)).toEqual([
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
		expect(providerModuleOf("chat-slack").id).toBe("chat")
		expect(providerModuleOf("chat-discord").id).toBe("chat")
		expect(providerModuleOf("linear").id).toBe("linear")
		expect(providerModuleOf("github").id).toBe("github")
		expect(providerModuleOf("prometheus").id).toBe("prometheus")
		expect(providerModuleOf("warpstream").id).toBe("prometheus")
		expect(providerModuleOf("gcp").id).toBe("gcp")
	})

	test("GitHub's account choice comes through its module and holds new connects until it settles", () => {
		const selection = Schema.decodeSync(GithubInstallationSelection)({
			state: "selection-1",
			needsApproval: [],
			unavailable: 0,
			installUrl: "https://github.test/apps/maple/installations/new?state=install-1",
			installations: [
				{
					id: "202",
					accountLogin: "acme",
					accountType: "organization",
					repositorySelection: "selected",
				},
			],
		})
		const model = init({ search: { integration: "github" } }, context).model
		const chosen = receivedCallback(model, context, "github", "success", null, selection)
		expect(chosen.model.githubCard.selection).toEqual(selection)
		expect(chosen.outMessage).toBeUndefined()
		const picking = pageUpdate(
			chosen.model,
			Message.GotGithubMessage({
				message: GithubMessage.ClickedSelectGithubInstallation({ installationId: "202" }),
			}),
		)
		expect(GITHUB_PROVIDER.blocksConnect(picking.model)).toBe(true)
		expect(clickedConnect(picking.model, context).model).toBe(picking.model)
	})

	test("GitHub's force-poll window ends with one last read", () => {
		const delayed = GITHUB_PROVIDER.delayed
		const model = init({ search: { integration: "github" } }, context).model
		expect(delayed?.versionOf(model)).toBe(null)
		const polling = {
			...model,
			githubCard: { ...model.githubCard, isForcePolling: true, forcePollVersion: 2 },
		}
		expect(delayed?.versionOf(polling)).toBe(2)
		const fired = delayed?.fire(2) ?? []
		const ended = Arr.reduce(fired, polling, (next, message) => pageUpdate(next, message).model)
		expect(ended.githubCard.isForcePolling).toBe(false)
		// The last read is the poll's own tick.
		expect(fired[0]).toEqual(GITHUB_PROVIDER.tickers[0]?.tick)
	})

	test("Prometheus and WarpStream share one scrape-target module, its polls and its badges", () => {
		const target = Schema.decodeSync(V2ScrapeTarget)({
			id: "scrp_YoxMqYdzUJ1tH4BqCWxPH3",
			object: "scrape_target",
			name: "redis exporter",
			service_name: null,
			url: "https://redis.internal:9121/metrics",
			target_type: "prometheus",
			organization: null,
			include_branches: [],
			exclude_branches: [],
			scrape_interval_seconds: 60,
			labels_json: null,
			auth_type: "none",
			has_credentials: false,
			managed_by: null,
			enabled: true,
			last_scrape_at: null,
			last_scrape_error: null,
			created_at: "2026-09-01T00:00:00.000Z",
			updated_at: "2026-09-02T00:00:00.000Z",
		})
		const [targetsPoll, checksPoll] = PROMETHEUS_PROVIDER.tickers
		const warpstream = init({ search: { integration: "warpstream" } }, context).model
		expect(targetsPoll?.isActive(warpstream)).toBe(true)
		expect(targetsPoll?.isActive(init({ search: { integration: "github" } }, context).model)).toBe(false)
		// The checks poll waits for a selection and starts over when it changes.
		expect(checksPoll?.dependency(warpstream)).toBe(null)
		const selected = pageUpdate(warpstream, scrape(PrometheusMessage.ClickedTarget({ id: target.id })))
		expect(names(selected.commands)).toEqual(["FetchScrapeTargetChecks"])
		expect(checksPoll?.dependency(selected.model)).toBe(target.id)
		const loaded = pageUpdate(
			warpstream,
			Message.CompletedLoadScrapeTargets({
				key: warpstream.statuses.scrapeTargets.key ?? "",
				result: Result.succeed([target]),
			}),
		).model
		// The list poll re-reads the targets through the hub.
		expect(names(targetsPoll === undefined ? [] : pageUpdate(loaded, targetsPoll.tick).commands)).toEqual(
			["LoadIntegrationsScrapeTargets"],
		)
		expect(cardStatusOf(loaded.statuses, "prometheus", NOW)).toEqual({
			label: "1 target · 1 enabled",
			variant: "ok",
		})
		expect(cardStatusOf(loaded.statuses, "warpstream", NOW)).toEqual({
			label: "Via Prometheus",
			variant: "outline",
		})
	})

	test("AWS is a module: its setup and stream polls, its badges, and a module change in place", () => {
		const id = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const connection = (overrides: Partial<V2AwsConnection>): V2AwsConnection => ({
			id,
			object: "aws_connection",
			account_id: Schema.decodeSync(AwsAccountId)("123456789012"),
			role_arn: "arn:aws:iam::123456789012:role/MapleIntegration-018f2b3c4d5e4f708192a3b4",
			oidc_issuer: "https://api.maple.dev/oidc/aws",
			oidc_subject: "aws-connection:018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
			modules: [],
			granted_modules: null,
			template_version: null,
			setup_outdated: false,
			verified_at: null,
			last_checked_at: null,
			last_check_error: null,
			metric_stream: null,
			metric_stream_changed_at: null,
			metrics_last_received_at: null,
			metrics_last_error: null,
			created_at: Schema.decodeSync(Timestamp)("2026-09-21T12:00:00.000Z"),
			...overrides,
		})
		const withAws = (model: Model, connections: ReadonlyArray<V2AwsConnection>) =>
			pageUpdate(
				model,
				Message.CompletedLoadAws({
					key: model.statuses.aws.key ?? "",
					result: Result.succeed({
						object: "aws_integration",
						available: true,
						modules: [{ module: "cost", title: "Cost", summary: "", available: true }],
						connections,
					}),
				}),
			).model
		expect(providerModuleOf("aws").id).toBe("aws")
		const [pendingPoll, watchPoll] = AWS_PROVIDER.tickers
		const pending = withAws(init({ search: { integration: "aws" } }, context).model, [connection({})])
		// The setup re-check runs only while this connection's setup is open.
		expect(pendingPoll?.isActive(pending)).toBe(false)
		const opened = pageUpdate(pending, aws(AwsMessage.ClickedAwsSetup({ id }))).model
		expect(pendingPoll?.isActive(opened)).toBe(true)
		expect(names(pendingPoll === undefined ? [] : pageUpdate(opened, pendingPoll.tick).commands)).toEqual(
			["CheckAwsConnection"],
		)
		expect(cardStatusOf(opened.statuses, "aws", NOW)).toEqual({ label: "Finish setup", variant: "warn" })
		expect(overviewOf(opened.statuses, NOW, "aws")).toMatchObject({ health: "pending" })
		// A verified, streaming connection is watched; elsewhere nothing is.
		const streaming = connection({
			verified_at: Schema.decodeSync(Timestamp)("2026-09-30T12:00:00.000Z"),
			metric_stream: Schema.decodeSync(AwsMetricStream)({
				regions: ["us-east-1"],
				namespaces: ["AWS/ECS"],
			}),
			metrics_last_received_at: Schema.decodeSync(Timestamp)("2026-10-01T11:59:00.000Z"),
		})
		const watched = withAws(init({ search: { integration: "aws" } }, context).model, [streaming])
		expect(watchPoll?.isActive(watched)).toBe(true)
		expect(watchPoll?.isActive(withAws(init({ search: {} }, context).model, [streaming]))).toBe(false)
		// Its tick re-reads the status.
		expect(names(watchPoll === undefined ? [] : pageUpdate(watched, watchPoll.tick).commands)).toContain(
			"LoadIntegrationsAwsStatus",
		)
		expect(cardStatusOf(watched.statuses, "aws", NOW)).toEqual({ label: "1 account", variant: "ok" })
		// An answered module change shows in the status before its re-read lands.
		const changed = pageUpdate(
			watched,
			aws(
				AwsMessage.CompletedAwsModules({
					id,
					connection: { ...streaming, modules: ["cost"] },
					error: null,
				}),
			),
		)
		const connections = AsyncData.getOrElse(
			AsyncData.map(changed.model.statuses.aws.data, (status) => status.connections),
			() => [],
		)
		expect(connections[0]?.modules).toEqual(["cost"])
		expect(names(changed.commands)).toContain("LoadAwsSetup")
		expect(changed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Cost turned on",
				description: "Run the setup again in AWS to grant it.",
			}),
		)
	})

	test("Google Cloud is a module: its status polls, the cleanup and run polls, its badges and header", () => {
		const connector = (id: string, over: Readonly<Record<string, unknown>>) => ({
			id: encodePublicId(
				PublicIdPrefixes.gcpConnector,
				`00000000-0000-4000-8000-00000000040${id === "one" ? 1 : 2}`,
			),
			object: "gcp_connector",
			scope_type: "project",
			scope_id: `acme-${id}`,
			project_id: `acme-${id}`,
			logs_enabled: true,
			metrics_enabled: false,
			security_enabled: false,
			created_at: "2026-09-01T00:00:00.000Z",
			last_log_received_at: "2026-10-01T11:58:00.000Z",
			last_log_error: null,
			applied_logs_enabled: true,
			applied_metrics_enabled: false,
			setup_reported_at: "2026-09-01T00:05:00.000Z",
			last_metrics_received_at: null,
			last_metrics_error: null,
			discovered_project_count: 1,
			last_resources_error: null,
			...over,
		})
		const withGcp = (model: Model, connectors: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
			const clocked = pageUpdate(model, Message.CompletedReadClock({ nowMs: NOW })).model
			return pageUpdate(
				clocked,
				Message.CompletedLoadGcp({
					key: clocked.statuses.gcp.key ?? "",
					result: Result.succeed(
						Schema.decodeUnknownSync(V2GcpIntegration)({
							object: "gcp_integration",
							metrics_available: true,
							connectors,
						}),
					),
				}),
			).model
		}
		const page = init({ search: { integration: "gcp" } }, context).model
		const [settlingPoll, steadyPoll, cleanupPoll, runPoll] = GCP_PROVIDER.tickers
		// A connection that needs attention is read every 10 s; a healthy one every minute.
		const settling = withGcp(page, [connector("one", { last_log_error: "denied" })])
		expect([settlingPoll?.isActive(settling), steadyPoll?.isActive(settling)]).toEqual([true, false])
		const healthy = withGcp(page, [connector("one", {})])
		expect([settlingPoll?.isActive(healthy), steadyPoll?.isActive(healthy)]).toEqual([false, true])
		const hub = withGcp(init({ search: {} }, context).model, [connector("one", {})])
		expect([settlingPoll?.isActive(hub), steadyPoll?.isActive(hub)]).toEqual([false, false])
		// A tick re-reads the status and the clock.
		const ticked = names(steadyPoll === undefined ? [] : pageUpdate(healthy, steadyPoll.tick).commands)
		expect(ticked).toContain("LoadIntegrationsGcpStatus")
		expect(ticked).toContain("ReadIntegrationsClock")
		// The cleanup dialog of a reported connection keeps reading the status while it is open.
		expect(cleanupPoll?.isActive(healthy)).toBe(false)
		const shownId = AsyncData.getOrElse(
			AsyncData.map(healthy.statuses.gcp.data, (status) => status.connectors),
			() => [],
		)[0]?.id
		const cleanup =
			shownId === undefined
				? healthy
				: pageUpdate(
						healthy,
						gcp(
							GcpMessage.GotGcpMenuMessage({
								id: shownId,
								message: Menu.Message.ClickedItem({
									index: 0,
									item: { kind: "Item", value: "disconnect" },
								}),
							}),
						),
					).model
		expect(cleanupPoll?.isActive(cleanup)).toBe(true)
		// The wizard's run step polls until the run is confirmed.
		expect(runPoll?.isActive(healthy)).toBe(false)
		expect(cardStatusOf(healthy.statuses, "gcp", NOW)).toEqual({ label: "1 connection", variant: "ok" })
		expect(overviewOf(healthy.statuses, NOW, "gcp")).toMatchObject({
			kind: "connected",
			health: "healthy",
			context: "Project acme-one",
		})
		// The header names how many connections share the worst state.
		scene(
			{ update: pageUpdate, view: withViewInputs(pageView, { context })() },
			given(withGcp(page, [connector("one", {}), connector("two", { last_log_error: "denied" })])),
			expectView(text(" · 1 of 2 connections")).toExist(),
		)
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
		const ticker = VERCEL_PROVIDER.tickers[0]
		expect(ticker?.isActive(withVercel({ integration: "vercel" }, settling))).toBe(true)
		expect(ticker?.isActive(withVercel({ integration: "vercel" }, VERCEL_STATUS))).toBe(false)
		expect(ticker?.isActive(withVercel({}, settling))).toBe(false)
		const shown = withVercel({ integration: "vercel" }, settling)
		// The tick re-reads the status, then the clock that ends the window.
		const sent = ticker === undefined ? [] : names(pageUpdate(shown, ticker.tick).commands)
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

	test("a connect runs the module's start, connected and popup hooks in place of the hub's re-read", () => {
		const model = init({ search: { integration: "cloudflare" } }, context).model
		const primed = { ...model, cloudflareCard: { ...model.cloudflareCard, isPrimed: true } }
		const started = pageUpdate(primed, Message.ClickedConnect())
		expect(started.model.cloudflareCard.isPrimed).toBe(false)
		const connected = names(
			receivedCallback(started.model, context, "cloudflare", "success", null).commands,
		)
		expect(connected).toContain("PrimeCloudflare")
		expect(connected).not.toContain("LoadIntegrationsCloudflareStatus")
		const active = {
			...started.model,
			connect: { ...started.model.connect, active: { provider: "cloudflare" as const, attempt: 1 } },
		}
		const closed = names(closedPopup(active, context, 1).commands)
		expect(closed).toContain("LoadIntegrationsCloudflareStatus")
		expect(closed).toContain("PrimeCloudflare")
	})

	test("a successful disconnect runs the module's hook, a failed one does not", () => {
		const entered = init({ search: { integration: "cloudflare" } }, context).model
		const model = pageUpdate(
			entered,
			Message.GotCloudflareMessage({
				message: CloudflareMessage.CompletedLoadUsage({
					key: entered.cloudflareCard.usage.key ?? "",
					result: Result.succeed(
						new CloudflareUsageResponse({
							windowStart: NOW - 3_600_000,
							windowEnd: NOW,
							bucketSeconds: 3600,
							totalRequests: 0,
							services: [],
						}),
					),
				}),
			}),
		).model
		const done = pageUpdate(
			model,
			Message.CompletedDisconnect({ integration: "cloudflare-multi", failure: null }),
		)
		expect(names(done.commands)).toContain("LoadIntegrationsCloudflareUsage")
		const failed = pageUpdate(
			model,
			Message.CompletedDisconnect({
				integration: "cloudflare",
				failure: toLoadFailure(new Error("no")),
			}),
		)
		expect(names(failed.commands)).not.toContain("LoadIntegrationsCloudflareUsage")
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
