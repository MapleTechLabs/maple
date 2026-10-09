import { describe, expect, it } from "vitest"

import { Option } from "effect"
import {
	cloudShellUrl,
	gcpConnectionState,
	gcpCreateRequest,
	gcpLogFilterChoice,
	gcpLogFilters,
	gcpLogState,
	gcpMetricsState,
	gcpOverlapNote,
	gcpPendingChanges,
	gcpScopeLabel,
	gcpScopeRoles,
	gcpScriptNeeded,
	gcpScriptOverdue,
	gcpSetupRunning,
	gcpSwitchLock,
	gcpWorstState,
	logRouterUrl,
	type GcpConnectorDraft,
} from "./gcp-connector-state"

const NOW = Date.parse("2026-10-08T12:00:00.000Z")
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

/** A project connection whose script ran an hour ago and that delivers both. */
const connector = (over: Partial<Parameters<typeof gcpConnectionState>[0]> = {}) => ({
	scope_type: "project" as const,
	logs_enabled: true,
	metrics_enabled: true,
	applied_logs_enabled: true as boolean | null,
	applied_metrics_enabled: true as boolean | null,
	setup_reported_at: ago(60) as string | null,
	last_log_received_at: ago(1) as string | null,
	last_log_error: null as string | null,
	last_metrics_received_at: ago(4) as string | null,
	last_metrics_error: null as string | null,
	discovered_project_count: 1,
	last_resources_error: null as string | null,
	...over,
})
/** As created: nothing reported, nothing arrived. */
const fresh = { applied_logs_enabled: null, applied_metrics_enabled: null, setup_reported_at: null }
const NEVER = { last_log_received_at: null, last_metrics_received_at: null }

describe("gcpLogState", () => {
	const log = (over: Parameters<typeof connector>[0]) => gcpLogState(connector(over), NOW)

	it("is off, and says whether the sink is still set up", () => {
		expect(log({ logs_enabled: false, applied_logs_enabled: false, last_log_error: "x" })).toEqual({
			kind: "off",
			stillSetUp: false,
		})
		expect(log({ logs_enabled: false, applied_logs_enabled: null })).toEqual({
			kind: "off",
			stillSetUp: false,
		})
		expect(log({ logs_enabled: false })).toEqual({ kind: "off", stillSetUp: true })
	})

	it("is failing while the last push was rejected, with the last accepted log", () => {
		expect(log({ last_log_error: "wrapped", last_log_received_at: ago(5) })).toEqual({
			kind: "failing",
			error: "wrapped",
			lastLogReceivedAt: ago(5),
		})
		expect(log({ ...fresh, ...NEVER, last_log_error: "wrapped" })).toMatchObject({
			kind: "failing",
			lastLogReceivedAt: null,
		})
	})

	it("is setup pending until a run reports log forwarding", () => {
		expect(log({ ...fresh, ...NEVER })).toEqual({ kind: "setup-pending" })
	})

	it("is setup pending after logs were removed and switched on again, whatever arrived before", () => {
		expect(log({ applied_logs_enabled: false, last_log_received_at: ago(22) })).toEqual({
			kind: "setup-pending",
		})
	})

	it("is setup running for two minutes after a run reported on metrics alone", () => {
		const midRun = { applied_logs_enabled: null, last_log_received_at: null }
		expect(log({ ...midRun, setup_reported_at: ago(1) })).toEqual({ kind: "setup-running" })
		expect(log({ ...midRun, setup_reported_at: ago(3) })).toEqual({ kind: "setup-pending" })
		// A report of removal is a finished section, not one that is still to come.
		expect(log({ applied_logs_enabled: false, setup_reported_at: ago(1) })).toEqual({
			kind: "setup-pending",
		})
	})

	it("trusts a log from the last 15 minutes over a missing report, not over a report of removal", () => {
		expect(log({ ...fresh, last_log_received_at: ago(14) })).toMatchObject({ kind: "receiving" })
		// The cleanup script just ran: the last entries it forwarded prove nothing.
		expect(log({ applied_logs_enabled: false, last_log_received_at: ago(1) })).toEqual({
			kind: "setup-pending",
		})
	})

	it("waits for the first log once a run reported, and is overdue after 20 minutes", () => {
		expect(log({ ...NEVER, setup_reported_at: ago(1) })).toEqual({
			kind: "waiting",
			reportedAt: ago(1),
			overdue: false,
		})
		expect(log({ ...NEVER, setup_reported_at: ago(21) })).toMatchObject({
			kind: "waiting",
			overdue: true,
		})
	})

	it("is idle after 24 hours without a log", () => {
		expect(log({ last_log_received_at: ago(3 * 24 * 60) })).toEqual({
			kind: "idle",
			lastLogReceivedAt: ago(3 * 24 * 60),
		})
	})

	it("is receiving otherwise", () => {
		expect(log({})).toEqual({ kind: "receiving", lastLogReceivedAt: ago(1) })
	})
})

describe("gcpMetricsState", () => {
	const metrics = (over: Parameters<typeof connector>[0]) => gcpMetricsState(connector(over), NOW)
	const SIGN_IN = "Maple can't sign in as this connection's read-only service account yet."

	it("is off, and says whether the service account is still set up", () => {
		expect(metrics({ metrics_enabled: false, applied_metrics_enabled: null })).toEqual({
			kind: "off",
			stillSetUp: false,
		})
		expect(metrics({ metrics_enabled: false, last_metrics_error: "x" })).toEqual({
			kind: "off",
			stillSetUp: true,
		})
	})

	it("is setup pending until a run reports, and hides the poller's sign-in error", () => {
		expect(metrics({ ...fresh, ...NEVER, last_metrics_error: SIGN_IN })).toEqual({
			kind: "setup-pending",
		})
	})

	it("is setup running for two minutes after a run reported on logs alone", () => {
		const midRun = { applied_metrics_enabled: null, ...NEVER, last_metrics_error: SIGN_IN }
		expect(metrics({ ...midRun, setup_reported_at: ago(1) })).toEqual({ kind: "setup-running" })
		expect(metrics({ ...midRun, setup_reported_at: ago(3) })).toEqual({ kind: "setup-pending" })
	})

	it("trusts a read from the last 15 minutes over a missing report, not over a report of removal", () => {
		expect(metrics({ ...fresh })).toMatchObject({ kind: "receiving" })
		expect(metrics({ applied_metrics_enabled: false })).toEqual({ kind: "setup-pending" })
	})

	it("waits for the first read, and for 10 minutes after a run whatever the poller said before", () => {
		expect(metrics({ ...NEVER, setup_reported_at: ago(14) })).toEqual({
			kind: "waiting",
			reportedAt: ago(14),
			overdue: false,
		})
		// Past 15 minutes the row stops promising the first read.
		expect(metrics({ ...NEVER, setup_reported_at: ago(20) })).toEqual({
			kind: "waiting",
			reportedAt: ago(20),
			overdue: true,
		})
		expect(metrics({ ...NEVER, setup_reported_at: ago(2), last_metrics_error: SIGN_IN })).toEqual({
			kind: "waiting",
			reportedAt: ago(2),
			overdue: false,
		})
		// Switched off, cleaned up and set up again: the old read and the error in between don't count.
		expect(
			metrics({
				last_metrics_received_at: ago(120),
				last_metrics_error: SIGN_IN,
				setup_reported_at: ago(2),
			}),
		).toMatchObject({ kind: "waiting" })
		// A run that repairs a connection whose reads fail.
		expect(
			metrics({
				last_metrics_received_at: ago(12),
				last_metrics_error: "denied",
				setup_reported_at: ago(2),
			}),
		).toMatchObject({ kind: "waiting" })
	})

	it("is failing once the grace is over and nothing was read in the last two polls", () => {
		expect(metrics({ ...NEVER, setup_reported_at: ago(11), last_metrics_error: SIGN_IN })).toEqual({
			kind: "failing",
			error: SIGN_IN,
			lastMetricsReceivedAt: null,
		})
		expect(metrics({ last_metrics_received_at: ago(11), last_metrics_error: "denied" })).toEqual({
			kind: "failing",
			error: "denied",
			lastMetricsReceivedAt: ago(11),
		})
	})

	it("is incomplete while a read from the last 10 minutes came with an error", () => {
		expect(metrics({ last_metrics_error: "3 of 46 metric queries failed." })).toEqual({
			kind: "incomplete",
			error: "3 of 46 metric queries failed.",
			lastMetricsReceivedAt: ago(4),
		})
		expect(metrics({ last_metrics_received_at: ago(9), last_metrics_error: "denied" })).toMatchObject({
			kind: "incomplete",
		})
	})

	it("keeps receiving when only the resource list is incomplete", () => {
		expect(metrics({ last_resources_error: "The resource list is incomplete." })).toMatchObject({
			kind: "receiving",
			resourcesError: "The resource list is incomplete.",
		})
	})

	it("is stalled after 30 minutes without a read and without an error", () => {
		expect(metrics({ last_metrics_received_at: ago(42) })).toEqual({
			kind: "stalled",
			lastMetricsReceivedAt: ago(42),
		})
	})

	it("is receiving otherwise, with the project count of a folder or organization", () => {
		expect(metrics({})).toEqual({
			kind: "receiving",
			lastMetricsReceivedAt: ago(4),
			projectCount: null,
			resourcesError: null,
		})
		expect(metrics({ scope_type: "organization", discovered_project_count: 14 })).toMatchObject({
			projectCount: 14,
		})
		expect(metrics({ scope_type: "folder", discovered_project_count: 0 })).toMatchObject({
			projectCount: null,
		})
	})
})

describe("gcpConnectionState", () => {
	const state = (over: Parameters<typeof connector>[0]) => gcpConnectionState(connector(over), NOW)

	it("needs attention when a capability is failing, incomplete or stalled", () => {
		expect(state({ last_log_error: "wrapped" })).toBe("attention")
		expect(state({ last_metrics_error: "3 of 46 metric queries failed." })).toBe("attention")
		expect(state({ last_metrics_received_at: ago(42) })).toBe("attention")
		// Worse than the other capability still waiting on its script.
		expect(state({ last_log_error: "wrapped", applied_metrics_enabled: false, ...NEVER })).toBe(
			"attention",
		)
	})

	it("is setup pending before any run reported", () => {
		expect(state({ ...fresh, ...NEVER })).toBe("setup-pending")
	})

	it("has changes pending when a switch and the last report disagree", () => {
		expect(state({ logs_enabled: false })).toBe("changes-pending")
		expect(state({ applied_metrics_enabled: false, last_metrics_received_at: ago(90) })).toBe(
			"changes-pending",
		)
	})

	it("waits between the sections of a first run, and is setup pending if the second never reports", () => {
		const midRun = { applied_metrics_enabled: null, setup_reported_at: ago(0), ...NEVER }
		expect(state(midRun)).toBe("waiting")
		expect(gcpSetupRunning(connector(midRun), NOW)).toBe(true)
		expect(gcpScriptNeeded(connector(midRun), NOW)).toBeNull()
		expect(gcpPendingChanges(connector(midRun), NOW)).toEqual([])

		const stopped = { ...midRun, setup_reported_at: ago(3) }
		expect(state(stopped)).toBe("setup-pending")
		expect(gcpSetupRunning(connector(stopped), NOW)).toBe(false)
	})

	it("waits for data once the script reported", () => {
		expect(state({ ...NEVER, setup_reported_at: ago(1) })).toBe("waiting")
	})

	it("is healthy while it receives, idles, or has a capability switched off and removed", () => {
		expect(state({})).toBe("healthy")
		expect(state({ last_log_received_at: ago(3 * 24 * 60) })).toBe("healthy")
		expect(state({ last_resources_error: "The resource list is incomplete." })).toBe("healthy")
		expect(state({ metrics_enabled: false, applied_metrics_enabled: false })).toBe("healthy")
		expect(state({ logs_enabled: false, applied_logs_enabled: null })).toBe("healthy")
	})
})

describe("gcpPendingChanges", () => {
	const changes = (over: Parameters<typeof connector>[0]) => gcpPendingChanges(connector(over), NOW)

	it("lists nothing while the switches match the last report, or before the first run", () => {
		expect(changes({})).toEqual([])
		expect(changes({ ...fresh, ...NEVER })).toEqual([])
	})

	it("lists what a re-run removes and creates", () => {
		expect(changes({ logs_enabled: false })).toEqual(["remove the log sink, topic and subscription"])
		expect(
			changes({
				logs_enabled: false,
				applied_metrics_enabled: false,
				last_metrics_received_at: ago(90),
			}),
		).toEqual([
			"remove the log sink, topic and subscription",
			"create the read-only service account and grant its roles",
		])
		expect(
			changes({ metrics_enabled: false, applied_logs_enabled: false, last_log_received_at: null }),
		).toEqual([
			"create the log sink, topic and subscription",
			"remove the read-only service account and its roles",
		])
	})
})

describe("gcpScriptNeeded", () => {
	const needed = (over: Parameters<typeof connector>[0]) => gcpScriptNeeded(connector(over), NOW)

	it("is null while the switches match what the runs reported", () => {
		expect(needed({})).toBeNull()
		expect(needed({ ...NEVER, setup_reported_at: ago(1) })).toBeNull()
	})

	it("says so whatever else is wrong: a failing capability does not hide a pending change", () => {
		expect(needed({ logs_enabled: false, last_metrics_error: "denied" })).toBe("changes-pending")
		expect(needed({ ...fresh, ...NEVER, last_log_error: "wrapped" })).toBe("setup-pending")
	})
})

describe("gcpScriptOverdue", () => {
	const OPENED = NOW - 60_000

	it("counts from the creation of a connection no run has reported on, not from the panel's opening", () => {
		const unreported = { setup_reported_at: null }
		expect(gcpScriptOverdue({ ...unreported, created_at: ago(4) }, OPENED, NOW)).toBe(false)
		expect(gcpScriptOverdue({ ...unreported, created_at: ago(6) }, OPENED, NOW)).toBe(true)
	})

	it("counts from the panel's opening once a run has reported", () => {
		const reported = { setup_reported_at: ago(30), created_at: ago(600) }
		expect(gcpScriptOverdue(reported, OPENED, NOW)).toBe(false)
		expect(gcpScriptOverdue(reported, NOW - 6 * 60_000, NOW)).toBe(true)
	})
})

describe("gcpWorstState", () => {
	it("takes the worst of several connections", () => {
		expect(gcpWorstState(["healthy", "waiting", "changes-pending"])).toBe("changes-pending")
		expect(gcpWorstState(["setup-pending", "attention"])).toBe("attention")
		expect(gcpWorstState(["healthy", "healthy"])).toBe("healthy")
	})
})

describe("gcpScopeRoles", () => {
	const both = { logs_enabled: true, metrics_enabled: true }

	it("asks for nothing beyond Owner on a project", () => {
		expect(gcpScopeRoles("project", both)).toEqual([])
	})

	it("asks for the sink role with logs and the IAM role with metrics", () => {
		expect(gcpScopeRoles("organization", both)).toEqual([
			"Logs Configuration Writer",
			"Organization Administrator",
		])
		expect(gcpScopeRoles("folder", { logs_enabled: false, metrics_enabled: true })).toEqual([
			"Folder IAM Admin",
		])
		expect(gcpScopeRoles("folder", { logs_enabled: true, metrics_enabled: false })).toEqual([
			"Logs Configuration Writer",
		])
	})
})

describe("gcpOverlapNote", () => {
	const project = { scope_type: "project" as const, scope_id: "acme-prod" }
	const staging = { scope_type: "project" as const, scope_id: "acme-staging" }
	const organization = { scope_type: "organization" as const, scope_id: "123456789012" }

	it("says nothing when the new scope cannot overlap an existing one", () => {
		expect(gcpOverlapNote("project", [])).toBeNull()
		expect(gcpOverlapNote("project", [project])).toBeNull()
		expect(gcpOverlapNote("folder", [organization])).toBeNull()
	})

	it("names the connected projects an organization or folder may contain", () => {
		expect(gcpOverlapNote("organization", [project, staging, organization])).toBe(
			"Projects you already connected (acme-prod, acme-staging) are collected twice if they sit inside this organization. Disconnect them once this connection receives data.",
		)
	})

	it("warns a project that it may sit inside a connected organization or folder", () => {
		expect(gcpOverlapNote("project", [organization])).toBe(
			"If this project sits inside an organization or folder you already connected, it is collected twice.",
		)
	})
})

describe("gcpSwitchLock", () => {
	const both = { logs_enabled: true, metrics_enabled: true }
	const logsOnly = { logs_enabled: true, metrics_enabled: false }
	const metricsOnly = { logs_enabled: false, metrics_enabled: true }

	it("leaves both switches free while both are on", () => {
		expect(gcpSwitchLock(both, "logs", true)).toBeNull()
		expect(gcpSwitchLock(both, "metrics", true)).toBeNull()
	})

	it("locks the last switch that is on", () => {
		expect(gcpSwitchLock(logsOnly, "logs", true)).toBe("last-on")
		expect(gcpSwitchLock(metricsOnly, "metrics", true)).toBe("last-on")
	})

	it("lets the other switch be turned on", () => {
		expect(gcpSwitchLock(logsOnly, "metrics", true)).toBeNull()
		expect(gcpSwitchLock(metricsOnly, "logs", true)).toBeNull()
	})

	it("locks metrics off when the deployment cannot read them", () => {
		expect(gcpSwitchLock(logsOnly, "metrics", false)).toBe("metrics-unavailable")
	})

	it("still lets metrics be turned off on such a deployment", () => {
		expect(gcpSwitchLock(both, "metrics", false)).toBeNull()
	})
})

describe("gcpScopeLabel", () => {
	it("names the scope kind and its id", () => {
		expect(gcpScopeLabel({ scope_type: "organization", scope_id: "123456789012" })).toBe(
			"Organization 123456789012",
		)
		expect(gcpScopeLabel({ scope_type: "project", scope_id: "acme-prod" })).toBe("Project acme-prod")
	})
})

describe("gcpCreateRequest", () => {
	const draft = (over: Partial<GcpConnectorDraft>): GcpConnectorDraft => ({
		scopeType: "project",
		scopeId: "",
		hostProjectId: "",
		logsEnabled: true,
		metricsEnabled: false,
		...over,
	})
	const optIns = { logs_enabled: true, metrics_enabled: false }
	const request = (over: Partial<GcpConnectorDraft>) => Option.getOrNull(gcpCreateRequest(draft(over)))

	it("sends a project as its own host project, trimmed", () => {
		expect(request({ scopeId: " acme-prod ", hostProjectId: "ignored-host" })).toEqual({
			scope_type: "project",
			scope_id: "acme-prod",
			...optIns,
		})
	})

	it("rejects a project name or number as a project ID", () => {
		expect(request({ scopeId: "Acme Prod" })).toBeNull()
		expect(request({ scopeId: "123456789012" })).toBeNull()
		expect(request({ scopeId: "acme-prod-" })).toBeNull()
	})

	it("sends a folder or organization with its host project", () => {
		expect(
			request({
				scopeType: "organization",
				scopeId: "123456789012",
				hostProjectId: "acme-observability",
			}),
		).toEqual({
			scope_type: "organization",
			scope_id: "123456789012",
			project_id: "acme-observability",
			...optIns,
		})
		expect(request({ scopeType: "folder", scopeId: "42", hostProjectId: "acme-observability" })).toEqual({
			scope_type: "folder",
			scope_id: "42",
			project_id: "acme-observability",
			...optIns,
		})
	})

	it("needs a numeric ID and a host project for a folder or organization", () => {
		expect(request({ scopeType: "folder", scopeId: "my-folder", hostProjectId: "acme-prod" })).toBeNull()
		expect(request({ scopeType: "organization", scopeId: "123456789012" })).toBeNull()
		expect(
			request({ scopeType: "organization", scopeId: "123456789012", hostProjectId: "Acme" }),
		).toBeNull()
	})
})

describe("gcpCreateRequest opt-ins", () => {
	const draft = (logsEnabled: boolean, metricsEnabled: boolean): GcpConnectorDraft => ({
		scopeType: "project",
		scopeId: "acme-prod",
		hostProjectId: "",
		logsEnabled,
		metricsEnabled,
	})

	it("sends a metrics-only connection in one request", () => {
		expect(Option.getOrNull(gcpCreateRequest(draft(false, true)))).toEqual({
			scope_type: "project",
			scope_id: "acme-prod",
			logs_enabled: false,
			metrics_enabled: true,
		})
	})

	it("needs at least one opt-in", () => {
		expect(Option.isNone(gcpCreateRequest(draft(false, false)))).toBe(true)
	})
})

describe("gcpLogFilters", () => {
	it("lists the recommended filter first, and keeping a filter only when a sink exists", () => {
		expect(gcpLogFilters(false).map((filter) => filter.value)).toEqual([
			"default",
			"include_gke_container_logs",
		])
		expect(gcpLogFilters(true).map((filter) => filter.value)).toEqual([
			"default",
			"include_gke_container_logs",
			"keep",
		])
		expect(gcpLogFilters(false)[0].label).toBe("Recommended: without GKE container logs")
	})
})

describe("gcpLogFilterChoice", () => {
	it("starts a new sink on the recommended filter and leaves an existing sink's filter alone", () => {
		expect(gcpLogFilterChoice(null, false, false)).toEqual({
			selected: "default",
			unacknowledged: false,
			scriptFilter: "default",
		})
		expect(gcpLogFilterChoice(null, false, true)).toEqual({
			selected: "keep",
			unacknowledged: false,
			scriptFilter: "keep",
		})
	})

	it("includes GKE container logs only once acknowledged", () => {
		expect(gcpLogFilterChoice("include_gke_container_logs", false, false)).toEqual({
			selected: "include_gke_container_logs",
			unacknowledged: true,
			scriptFilter: "default",
		})
		// An existing sink's filter is not replaced by a choice that was never confirmed.
		expect(gcpLogFilterChoice("include_gke_container_logs", false, true).scriptFilter).toBe("keep")
		expect(gcpLogFilterChoice("include_gke_container_logs", true, true)).toEqual({
			selected: "include_gke_container_logs",
			unacknowledged: false,
			scriptFilter: "include_gke_container_logs",
		})
	})

	it("applies the other filters as chosen", () => {
		expect(gcpLogFilterChoice("default", false, true).scriptFilter).toBe("default")
		expect(gcpLogFilterChoice("keep", false, true).scriptFilter).toBe("keep")
	})
})

describe("logRouterUrl", () => {
	it("opens the Log Router of the scope that holds the sink", () => {
		expect(logRouterUrl({ scope_type: "project", scope_id: "acme-prod" })).toBe(
			"https://console.cloud.google.com/logs/router?project=acme-prod",
		)
		expect(logRouterUrl({ scope_type: "folder", scope_id: "123456789012" })).toBe(
			"https://console.cloud.google.com/logs/router?folder=123456789012",
		)
		expect(logRouterUrl({ scope_type: "organization", scope_id: "123456789012" })).toBe(
			"https://console.cloud.google.com/logs/router?organizationId=123456789012",
		)
	})
})

describe("cloudShellUrl", () => {
	it("opens the console on the host project with Cloud Shell attached", () => {
		expect(cloudShellUrl("acme-prod")).toBe(
			"https://console.cloud.google.com/?cloudshell=true&project=acme-prod",
		)
	})
})
