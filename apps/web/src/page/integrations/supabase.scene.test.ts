import { OrgId } from "@maple/domain"
import { SupabaseIntegrationStatus } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { overviewOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import type { SupabaseProjectRow } from "../infra-integrations/supabase/model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const REF = Schema.decodeSync(SupabaseProjectRef)("abcdefghijklmnopqrst")
const PAUSED_REF = Schema.decodeSync(SupabaseProjectRef)("pausedprojectabcdefg")
const NOW = Date.parse("2026-10-01T12:00:00Z")

const metricsRow = (projectRef: string, overrides: Partial<SupabaseProjectRow> = {}): SupabaseProjectRow => ({
	projectRef,
	cpuAvg: 0.2,
	cpuMax: 0.3,
	memoryAvg: 0.5,
	memoryMax: 0.6,
	memoryTotal: 2 * 1024 ** 3,
	diskUsedMax: 0.3,
	diskSize: 8e9,
	dbSize: 1e7,
	connectionsAvg: 10,
	connectionsMax: 20,
	maxConnections: 90,
	requests: 1000,
	requestsPerMinute: 16,
	errors5xx: 1,
	issueCount: 3,
	lastSeen: "2026-10-01 11:59:37",
	...overrides,
})

const status = (overrides: Record<string, unknown> = {}) =>
	Schema.decodeUnknownSync(SupabaseIntegrationStatus)({
		configured: true,
		connected: true,
		organization: { id: "org-1", slug: "acme", name: "Acme" },
		connectedByUserId: null,
		connectedAt: 1_760_000_000_000,
		revoked: false,
		lastDiscoveryAt: 1_760_000_000_000,
		lastDiscoveryError: null,
		projects: [
			{
				ref: REF,
				name: "storefront",
				region: "eu-central-1",
				status: "ACTIVE_HEALTHY",
				metricsEnabled: true,
				logDrainEnabled: false,
				logDrainError: null,
				logDrainSourceId: null,
				logDrains: [],
				logDrainsCheckedAt: null,
				logsEnabled: true,
				logsLastPolledAt: NOW - 41_000,
				logsError: "Supabase refused the logs query: Unknown field",
				lastSeenAt: 1_760_000_000_000,
			},
			{
				ref: PAUSED_REF,
				name: "sandbox",
				region: "us-east-1",
				status: "INACTIVE",
				metricsEnabled: false,
				logDrainEnabled: false,
				logDrainError: null,
				logDrainSourceId: null,
				logDrains: [],
				logDrainsCheckedAt: null,
				logsEnabled: false,
				logsLastPolledAt: null,
				logsError: null,
				lastSeenAt: 1_760_000_000_000,
			},
		],
		...overrides,
	})

const withStatus = (value: SupabaseIntegrationStatus): Model => {
	const model = init({ search: { integration: "supabase" } }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadSupabase({
			key: model.statuses.supabase.key ?? "",
			result: Result.succeed(value),
		}),
	).model
}

/** Connected, clock read, and the metrics rows answered. */
const withMetrics = (rows: ReadonlyArray<SupabaseProjectRow>): Model => {
	const clocked = pageUpdate(withStatus(status()), Message.CompletedReadClock({ nowMs: NOW })).model
	return pageUpdate(
		clocked,
		Message.CompletedLoadSupabaseMetrics({
			key: clocked.supabaseCard.metrics.key ?? "",
			result: Result.succeed(rows),
		}),
	).model
}

describe("supabase card", () => {
	test("a disconnected organization offers the OAuth connect", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status({ connected: false, organization: null, projects: [] }))),
			expectView(role("button", { name: "Connect Supabase" })).toExist(),
		)
	})

	test("a deployment without the OAuth app explains it and offers no connect", () => {
		const model = withStatus(
			status({ configured: false, connected: false, organization: null, projects: [] }),
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Supabase isn't configured on this deployment.")).toExist(),
			expectView(role("button", { name: "Connect Supabase" })).toBeAbsent(),
		)
		expect(overviewOf(model.statuses, model.nowMs, "supabase")).toEqual({ kind: "unavailable" })
	})

	test("a connected organization lists its projects with a metrics switch and a paused pill", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status())),
			expectView(text("storefront")).toExist(),
			expectView(role("switch", { name: "Collect metrics for storefront" })).toHaveAttr(
				"aria-checked",
				"true",
			),
			expectView(text("Paused")).toExist(),
			expectView(role("button", { name: "Sync now" })).toExist(),
			expectView(
				text(
					"Logs are pulled every minute through your grant and count toward ingest. A log drain has Supabase push them instead: it needs a Pro plan and Supabase bills it per drain.",
				),
			).toExist(),
			expectView(role("link", { name: "View in Infrastructure" })).toExist(),
		)
	})

	test("the last hour's metrics rows are read once the clock is in and the card is connected", () => {
		const connected = withStatus(status())
		const clocked = pageUpdate(connected, Message.CompletedReadClock({ nowMs: NOW }))
		expect(names(clocked.commands)).toContain("LoadIntegrationsSupabaseMetrics")
		const disconnected = pageUpdate(
			withStatus(status({ connected: false, organization: null, projects: [] })),
			Message.CompletedReadClock({ nowMs: NOW }),
		)
		expect(names(disconnected.commands)).not.toContain("LoadIntegrationsSupabaseMetrics")
	})

	test("last data shows each source's freshness, and a paused project resumes when unpaused", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMetrics([metricsRow(REF)])),
			expectView(text("metrics 23s · logs 41s")).toExist(),
			expectView(text("resumes when unpaused")).toExist(),
			expectView(text("Healthy")).toExist(),
		)
	})

	test("a project near its connection limit reads degraded", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMetrics([metricsRow(REF, { connectionsMax: 88 })])),
			expectView(text("Degraded")).toExist(),
		)
	})

	test("a switched-on project without metrics waits for its first scrape; a failed read says unavailable", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMetrics([])),
			expectView(text("waiting for first scrape · logs 41s")).toExist(),
			expectView(text("No data")).toExist(),
			expectView(text("Healthy")).toBeAbsent(),
		)
		const clocked = pageUpdate(withStatus(status()), Message.CompletedReadClock({ nowMs: NOW })).model
		const failed = pageUpdate(
			clocked,
			Message.CompletedLoadSupabaseMetrics({
				key: clocked.supabaseCard.metrics.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("metrics unavailable · logs 41s")).toExist(),
			expectView(text("storefront")).toExist(),
			expectView(text("No data")).toExist(),
			expectView(text("Healthy")).toBeAbsent(),
		)
	})

	test("while the metrics rows load a running project reads checking, not healthy", () => {
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(withStatus(status()), Message.CompletedReadClock({ nowMs: NOW })).model),
			expectView(text("Checking")).toExist(),
			expectView(text("Healthy")).toBeAbsent(),
		)
	})

	test("a paused project's switches are disabled; a running project's dispatch their toggles", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status())),
			expectView(role("switch", { name: "Collect metrics for sandbox" })).toBeDisabled(),
			expectView(role("switch", { name: "Collect logs for sandbox" })).toBeDisabled(),
			expectView(role("switch", { name: "Collect logs for storefront" })).toBeEnabled(),
			expectView(role("switch", { name: "Collect logs for storefront" })).toHaveAttr(
				"aria-checked",
				"true",
			),
		)
		const sent = pageUpdate(
			withStatus(status()),
			Message.ToggledSupabaseMetrics({ ref: REF, enabled: false }),
		)
		expect(names(sent.commands)).toEqual(["SetSupabaseProjectMetrics"])
		scene(
			{ update: pageUpdate, view },
			given(sent.model),
			expectView(role("switch", { name: "Collect metrics for storefront" })).toBeDisabled(),
		)
	})

	test("each project has a logs switch and shows its last logs error inline", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status())),
			expectView(role("switch", { name: "Collect logs for storefront" })).toExist(),
			expectView(role("switch", { name: "Collect logs for sandbox" })).toExist(),
			expectView(text("Supabase refused the logs query: Unknown field", { exact: false })).toExist(),
		)
	})

	test("a logs switch shares the project's pending write and toasts on failure", () => {
		const sent = pageUpdate(
			withStatus(status()),
			Message.ToggledSupabaseLogs({ ref: REF, enabled: false }),
		)
		expect(names(sent.commands)).toEqual(["SetSupabaseProjectLogs"])
		expect(
			names(
				pageUpdate(sent.model, Message.ToggledSupabaseMetrics({ ref: REF, enabled: false })).commands,
			),
		).toEqual([])
		const failed = pageUpdate(
			sent.model,
			Message.CompletedSupabaseLogs({ ref: REF, enabled: false, failure: toLoadFailure("boom") }),
		)
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			expectView(role("switch", { name: "Collect logs for storefront" })).toBeEnabled(),
			expectView(role("switch", { name: "Collect logs for storefront" })).toHaveAttr(
				"aria-checked",
				"true",
			),
		)
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Failed to stop collecting logs",
				description: toLoadFailure("boom").message,
			}),
		)
	})

	test("drains set up in Supabase are listed, and one to Maple blocks a managed drain", () => {
		const withDrains = status({
			projects: [
				{
					...status().projects[0],
					logDrains: [
						{
							id: "drain-datadog",
							name: "soc2-archive",
							backendType: "datadog",
							destination: "US1",
							toMaple: false,
							managedByMaple: false,
						},
						{
							id: "drain-manual",
							name: "maple by hand",
							backendType: "otlp",
							destination: "ingest.maple.dev",
							toMaple: true,
							managedByMaple: false,
						},
					],
					logDrainsCheckedAt: NOW,
				},
			],
		})
		scene(
			{ update: pageUpdate, view },
			given(withStatus(withDrains)),
			expectView(
				text("Drains: soc2-archive (datadog, US1), maple by hand (already sends to Maple)"),
			).toExist(),
			expectView(
				role("switch", {
					name: "storefront already sends logs to Maple through the drain maple by hand",
				}),
			).toBeDisabled(),
		)
	})

	test("an enabled drain locks the logs switch off and shows its error", () => {
		const drained = status({
			projects: [
				{
					...status().projects[0],
					logsEnabled: false,
					logDrainEnabled: true,
					logDrainError: "The log drain was removed in Supabase.",
				},
			],
		})
		scene(
			{ update: pageUpdate, view },
			given(withStatus(drained)),
			expectView(role("switch", { name: "Collect logs for storefront" })).toBeDisabled(),
			expectView(
				role("switch", { name: "Send storefront's logs through a Supabase log drain" }),
			).toHaveAttr("aria-checked", "true"),
			expectView(text("Drain: The log drain was removed in Supabase.")).toExist(),
			expectView(text("logs via drain", { exact: false })).toExist(),
		)
	})

	test("a drain switch writes once, shows polling off while it saves, and toasts a plan refusal", () => {
		const sent = pageUpdate(
			withStatus(status()),
			Message.ToggledSupabaseLogDrain({ ref: REF, enabled: true }),
		)
		expect(names(sent.commands)).toEqual(["SetSupabaseProjectLogDrain"])
		scene(
			{ update: pageUpdate, view },
			given(sent.model),
			expectView(role("switch", { name: "Collect logs for storefront" })).toHaveAttr(
				"aria-checked",
				"false",
			),
		)
		const failed = pageUpdate(
			sent.model,
			Message.CompletedSupabaseLogDrain({
				ref: REF,
				enabled: true,
				failure: toLoadFailure("Log drains need a Supabase Pro plan or higher."),
			}),
		)
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Failed to create the log drain",
				description: toLoadFailure("Log drains need a Supabase Pro plan or higher.").message,
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			expectView(role("switch", { name: "Collect logs for storefront" })).toHaveAttr(
				"aria-checked",
				"true",
			),
		)
	})

	test("revoked access asks to reconnect and reads as needing attention", () => {
		const model = withStatus(status({ revoked: true }))
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("button", { name: "Reconnect" })).toExist(),
			expectView(text("Access revoked")).toExist(),
		)
		const overview = overviewOf(model.statuses, model.nowMs, "supabase")
		expect(overview?.kind === "connected" ? overview.issue : null).toBe("Reconnect to resume")
	})

	test("a metrics switch writes once per project until its answer, then re-reads the status", () => {
		const model = withStatus(status())
		const sent = pageUpdate(model, Message.ToggledSupabaseMetrics({ ref: REF, enabled: false }))
		expect(names(sent.commands)).toEqual(["SetSupabaseProjectMetrics"])
		expect(
			names(
				pageUpdate(sent.model, Message.ToggledSupabaseMetrics({ ref: REF, enabled: false })).commands,
			),
		).toEqual([])
		const done = pageUpdate(
			sent.model,
			Message.CompletedSupabaseMetrics({ ref: REF, enabled: false, failure: null }),
		)
		expect(names(done.commands)).toContain("LoadIntegrationsSupabaseStatus")
		expect(names(done.commands)).toContain("ReadSupabaseClock")
	})

	test("a settled switch re-reads the metrics rows, so the new rows replace the entry-time verdict", () => {
		const before = withMetrics([])
		const sent = pageUpdate(before, Message.ToggledSupabaseMetrics({ ref: REF, enabled: true }))
		const done = pageUpdate(
			sent.model,
			Message.CompletedSupabaseMetrics({ ref: REF, enabled: true, failure: null }),
		)
		expect(names(done.commands)).toContain("ReadSupabaseClock")
		// Same clock, same window: the re-read still goes out, superseding the pre-write rows.
		const clocked = pageUpdate(done.model, Message.CompletedReadSupabaseClock({ nowMs: NOW }))
		expect(names(clocked.commands)).toContain("LoadIntegrationsSupabaseMetrics")
		const reread = pageUpdate(
			clocked.model,
			Message.CompletedLoadSupabaseMetrics({
				key: clocked.model.supabaseCard.metrics.key ?? "",
				result: Result.succeed([metricsRow(REF)]),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(reread),
			expectView(text("metrics 23s · logs 41s")).toExist(),
			expectView(text("Healthy")).toExist(),
		)
		const logs = pageUpdate(
			pageUpdate(before, Message.ToggledSupabaseLogs({ ref: REF, enabled: false })).model,
			Message.CompletedSupabaseLogs({ ref: REF, enabled: false, failure: null }),
		)
		expect(names(logs.commands)).toContain("ReadSupabaseClock")
	})

	test("a switch toggled long after mount re-reads the hour ending now, not at mount", () => {
		const later = NOW + 80 * 60_000
		const sent = pageUpdate(withMetrics([]), Message.ToggledSupabaseMetrics({ ref: REF, enabled: true }))
		const done = pageUpdate(
			sent.model,
			Message.CompletedSupabaseMetrics({ ref: REF, enabled: true, failure: null }),
		)
		const clocked = pageUpdate(done.model, Message.CompletedReadSupabaseClock({ nowMs: later }))
		const load = (clocked.commands ?? []).find(({ name }) => name === "LoadIntegrationsSupabaseMetrics")
		expect(load?.args).toEqual({
			key: clocked.model.supabaseCard.metrics.key,
			window: { startTime: "2026-10-01 12:20:00", endTime: "2026-10-01 13:20:00" },
		})
		const reread = pageUpdate(
			clocked.model,
			Message.CompletedLoadSupabaseMetrics({
				key: clocked.model.supabaseCard.metrics.key ?? "",
				result: Result.succeed([metricsRow(REF, { lastSeen: "2026-10-01 13:19:30" })]),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(reread),
			expectView(text("waiting for first scrape", { exact: false })).toBeAbsent(),
			expectView(text("Healthy")).toExist(),
		)
	})

	test("the card's clock tick advances the window, so the rows re-read on the new hour", () => {
		const ticked = pageUpdate(withMetrics([metricsRow(REF)]), Message.TickedSupabaseClock())
		expect(names(ticked.commands)).toEqual(["ReadIntegrationsClock"])
		const clocked = pageUpdate(ticked.model, Message.CompletedReadClock({ nowMs: NOW + 60_000 }))
		expect(names(clocked.commands)).toContain("LoadIntegrationsSupabaseMetrics")
		expect(clocked.model.nowMs).toBe(NOW + 60_000)
	})

	test("a successful connect syncs the projects, then re-reads the status", () => {
		const connected = pageUpdate(
			withStatus(status({ connected: false, organization: null, projects: [] })),
			Message.ReceivedConnectMessage({ provider: "supabase", status: "success", message: null }),
		)
		expect(names(connected.commands)).toContain("SyncSupabase")
		expect(connected.model.supabaseCard.isSyncing).toBe(true)
		const synced = pageUpdate(connected.model, Message.CompletedSupabaseSync({ failure: null }))
		expect(synced.model.supabaseCard.isSyncing).toBe(false)
		expect(names(synced.commands)).toEqual(["LoadIntegrationsSupabaseStatus"])
	})

	test("a failed sync toasts and still re-reads the status", () => {
		const syncing = pageUpdate(withStatus(status()), Message.ClickedSupabaseSync())
		const failed = pageUpdate(
			syncing.model,
			Message.CompletedSupabaseSync({ failure: toLoadFailure("boom") }),
		)
		expect(failed.model.supabaseCard.isSyncing).toBe(false)
		expect(names(failed.commands)).toEqual(["LoadIntegrationsSupabaseStatus"])
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Failed to sync Supabase",
				description: toLoadFailure("boom").message,
			}),
		)
	})

	test("a flipped switch shows the new value while saving and keeps it until the status re-read lands", () => {
		const metricsSwitch = role("switch", { name: "Collect metrics for storefront" })
		const sent = pageUpdate(
			withStatus(status()),
			Message.ToggledSupabaseMetrics({ ref: REF, enabled: false }),
		)
		scene(
			{ update: pageUpdate, view },
			given(sent.model),
			expectView(metricsSwitch).toHaveAttr("aria-checked", "false"),
			expectView(metricsSwitch).toBeDisabled(),
			expectView(role("switch", { name: "Collect logs for storefront" })).toHaveAttr(
				"aria-checked",
				"true",
			),
		)
		const done = pageUpdate(
			sent.model,
			Message.CompletedSupabaseMetrics({ ref: REF, enabled: false, failure: null }),
		)
		// The write landed but the status still holds the old value: the switch must not bounce back.
		scene(
			{ update: pageUpdate, view },
			given(done.model),
			expectView(metricsSwitch).toHaveAttr("aria-checked", "false"),
		)
		const [first, second] = status().projects
		const reread = pageUpdate(
			done.model,
			Message.CompletedLoadSupabase({
				key: done.model.statuses.supabase.key ?? "",
				result: Result.succeed(status({ projects: [{ ...first, metricsEnabled: false }, second] })),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(reread),
			expectView(metricsSwitch).toHaveAttr("aria-checked", "false"),
			expectView(metricsSwitch).toBeEnabled(),
		)
	})

	test("a status read superseded by the write does not retire the flip", () => {
		const model = withStatus(status())
		const staleKey = model.statuses.supabase.key ?? ""
		const sent = pageUpdate(model, Message.ToggledSupabaseMetrics({ ref: REF, enabled: false }))
		const done = pageUpdate(
			sent.model,
			Message.CompletedSupabaseMetrics({ ref: REF, enabled: false, failure: null }),
		)
		const stale = pageUpdate(
			done.model,
			Message.CompletedLoadSupabase({ key: staleKey, result: Result.succeed(status()) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(stale),
			expectView(role("switch", { name: "Collect metrics for storefront" })).toHaveAttr(
				"aria-checked",
				"false",
			),
		)
	})

	test("a failed metrics write frees the switch and toasts", () => {
		const sent = pageUpdate(
			withStatus(status()),
			Message.ToggledSupabaseMetrics({ ref: REF, enabled: true }),
		)
		const failed = pageUpdate(
			sent.model,
			Message.CompletedSupabaseMetrics({ ref: REF, enabled: true, failure: toLoadFailure("boom") }),
		)
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			expectView(role("switch", { name: "Collect metrics for storefront" })).toBeEnabled(),
			expectView(role("switch", { name: "Collect metrics for storefront" })).toHaveAttr(
				"aria-checked",
				"true",
			),
		)
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Failed to start collecting metrics",
				description: toLoadFailure("boom").message,
			}),
		)
	})
})
