import { describe, expect, it } from "vitest"

import { Option } from "effect"
import { GcpLogRuntime } from "@maple/domain/primitives"
import {
	GCP_LOG_RUNTIMES,
	cloudShellUrl,
	gcpApplyLine,
	gcpCollectLock,
	gcpConnectionState,
	gcpCreateRequest,
	gcpDraftEffect,
	gcpApplicationLogsLine,
	gcpLogFilterChoice,
	gcpLogState,
	gcpMessageParts,
	gcpMetricsState,
	gcpOverlapNote,
	gcpPendingChanges,
	gcpRunAsked,
	gcpScopeLabel,
	gcpScopeRoles,
	gcpScriptNeeded,
	gcpScriptOverdue,
	gcpSetupRunning,
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

	it("has changes pending when the configuration and the last report disagree", () => {
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

	it("lists nothing while the configuration matches the last report, or before the first run", () => {
		expect(changes({})).toEqual([])
		expect(changes({ ...fresh, ...NEVER })).toEqual([])
	})

	const LOGS_START = "Log forwarding starts once the script has created the log sink."
	const LOGS_STOP =
		"Google Cloud keeps forwarding logs, billed by Google, until the script has removed the log sink."
	const METRICS_START =
		"Metrics and resources start once the script has created the read-only service account."
	const METRICS_STOP =
		"The read-only service account stays in Google Cloud until the script has removed it."

	it("says what goes on until a re-run removes and creates", () => {
		expect(changes({ logs_enabled: false })).toEqual([LOGS_STOP])
		expect(
			changes({
				logs_enabled: false,
				applied_metrics_enabled: false,
				last_metrics_received_at: ago(90),
			}),
		).toEqual([LOGS_STOP, METRICS_START])
		expect(
			changes({ metrics_enabled: false, applied_logs_enabled: false, last_log_received_at: null }),
		).toEqual([LOGS_START, METRICS_STOP])
	})
})

describe("gcpScriptNeeded", () => {
	const needed = (over: Parameters<typeof connector>[0]) => gcpScriptNeeded(connector(over), NOW)

	it("is null while the configuration matches what the runs reported", () => {
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

describe("gcpCollectLock", () => {
	const both = { logs_enabled: true, metrics_enabled: true }
	const logsOnly = { logs_enabled: true, metrics_enabled: false }
	const metricsOnly = { logs_enabled: false, metrics_enabled: true }

	it("leaves both free while both are on", () => {
		expect(gcpCollectLock(both, "logs", true)).toBeNull()
		expect(gcpCollectLock(both, "metrics", true)).toBeNull()
	})

	it("locks the last one that is on", () => {
		expect(gcpCollectLock(logsOnly, "logs", true)).toBe("last-on")
		expect(gcpCollectLock(metricsOnly, "metrics", true)).toBe("last-on")
	})

	it("lets the other be turned on", () => {
		expect(gcpCollectLock(logsOnly, "metrics", true)).toBeNull()
		expect(gcpCollectLock(metricsOnly, "logs", true)).toBeNull()
	})

	it("locks metrics off when the deployment cannot read them", () => {
		expect(gcpCollectLock(logsOnly, "metrics", false)).toBe("metrics-unavailable")
	})

	it("still lets metrics be turned off on such a deployment", () => {
		expect(gcpCollectLock(both, "metrics", false)).toBeNull()
	})
})

describe("gcpDraftEffect", () => {
	it("starts a capability only once the script has run", () => {
		expect(gcpDraftEffect(connector({ ...fresh, ...NEVER }), "logs", true)).toBe("starts-after-script")
		expect(
			gcpDraftEffect(
				connector({ metrics_enabled: false, applied_metrics_enabled: false }),
				"metrics",
				true,
			),
		).toBe("starts-after-script")
	})

	it("changes nothing for a capability that stays as it is", () => {
		expect(gcpDraftEffect(connector(), "logs", true)).toBeNull()
		expect(
			gcpDraftEffect(
				connector({ metrics_enabled: false, applied_metrics_enabled: false }),
				"metrics",
				false,
			),
		).toBeNull()
	})

	it("stops in Maple at once when a capability that is set up is turned off", () => {
		expect(gcpDraftEffect(connector(), "logs", false)).toBe("stops-now")
		expect(gcpDraftEffect(connector(), "metrics", false)).toBe("stops-now")
	})

	it("counts arrived data as set up when no run reported", () => {
		expect(gcpDraftEffect(connector(fresh), "logs", false)).toBe("stops-now")
	})

	it("stops nothing when what is turned off was never set up", () => {
		expect(gcpDraftEffect(connector({ ...fresh, ...NEVER }), "logs", false)).toBeNull()
	})

	it("leaves the removal to the script for a capability already off in Maple", () => {
		expect(gcpDraftEffect(connector({ logs_enabled: false }), "logs", false)).toBe("removed-by-script")
	})

	it("resumes at once when a capability is turned back on before the script removed it", () => {
		expect(gcpDraftEffect(connector({ logs_enabled: false }), "logs", true)).toBe("resumes-now")
	})
})

describe("gcpRunAsked", () => {
	const RESET = "The subscription wraps each entry. Run the setup script again: it resets the subscription."

	it("names the capabilities whose failure asks for the setup script", () => {
		expect(gcpRunAsked(connector({ last_log_error: RESET }), NOW)).toEqual(["logs"])
		expect(
			gcpRunAsked(
				connector({
					last_log_error: RESET,
					last_metrics_error: "Maple can't sign in. Run the setup script and read its last lines.",
					last_metrics_received_at: ago(50),
				}),
				NOW,
			),
		).toEqual(["logs", "metrics"])
	})

	it("asks for nothing when a failure has another remedy, or nothing fails", () => {
		expect(
			gcpRunAsked(connector({ last_log_error: "Over the plan limit. See Settings, Billing." }), NOW),
		).toEqual([])
		expect(gcpRunAsked(connector(), NOW)).toEqual([])
	})

	it("does not ask for a capability that is off, whatever its last error says", () => {
		expect(gcpRunAsked(connector({ logs_enabled: false, last_log_error: RESET }), NOW)).toEqual([])
	})
})

describe("gcpApplyLine", () => {
	it("says what the run does about a capability", () => {
		expect(gcpApplyLine(true, true)).toBe("On")
		expect(gcpApplyLine(true, null)).toBe("On after this run")
		expect(gcpApplyLine(true, false)).toBe("On after this run")
		expect(gcpApplyLine(false, true)).toBe("Off in Maple. This run removes it from Google Cloud.")
		expect(gcpApplyLine(false, false)).toBe("Off")
		expect(gcpApplyLine(false, null)).toBe("Off")
	})
})

describe("gcpMessageParts", () => {
	it("cuts the first sentence, the remedy and what Google answered, without rewording", () => {
		expect(
			gcpMessageParts(
				"Maple can't sign in as this connection's read-only service account yet. After a setup run Google needs a few minutes to accept the new grant, and Maple retries every 5 minutes. If this stays, run the setup script and read its last lines. (IAM Credentials returned 403)",
			),
		).toEqual({
			headline: "Maple can't sign in as this connection's read-only service account yet",
			body: [
				"After a setup run Google needs a few minutes to accept the new grant, and Maple retries every 5 minutes.",
				"If this stays, run the setup script and read its last lines.",
			],
			answer: "IAM Credentials returned 403",
		})
	})

	it("keeps an address whole and starts a new line after it", () => {
		expect(
			gcpMessageParts(
				"The host project acme has no active billing account. Link one: https://console.cloud.google.com/billing/linkedaccount?project=acme Maple retries every 5 minutes. (Cloud Monitoring returned 403, BILLING_DISABLED)",
			),
		).toEqual({
			headline: "The host project acme has no active billing account",
			body: [
				"Link one: https://console.cloud.google.com/billing/linkedaccount?project=acme",
				"Maple retries every 5 minutes.",
			],
			answer: "Cloud Monitoring returned 403, BILLING_DISABLED",
		})
	})

	it("does not cut inside a metric name", () => {
		expect(
			gcpMessageParts(
				"3 of 46 metric queries failed, first run.googleapis.com/request_latencies. The rest were stored.",
			),
		).toEqual({
			headline: "3 of 46 metric queries failed, first run.googleapis.com/request_latencies",
			body: ["The rest were stored."],
			answer: null,
		})
	})

	it("is a headline alone for a single sentence", () => {
		expect(gcpMessageParts("Maple retries on its own.")).toEqual({
			headline: "Maple retries on its own",
			body: [],
			answer: null,
		})
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

describe("gcpLogFilterChoice", () => {
	const untouched = { keep: null, runtimes: null }

	it("starts a new sink on the default runtimes and leaves an existing sink's filter alone", () => {
		expect(gcpLogFilterChoice(untouched, false)).toEqual({
			keep: false,
			runtimes: ["cloud_run", "cloud_functions", "app_engine"],
			applicationLogs: ["cloud_run", "cloud_functions", "app_engine"],
		})
		expect(gcpLogFilterChoice(untouched, true).applicationLogs).toBeUndefined()
	})

	it("has no filter to keep before a sink exists", () => {
		expect(gcpLogFilterChoice({ keep: true, runtimes: null }, false).keep).toBe(false)
	})

	it("asks for exactly the ticked runtimes once the filter is replaced", () => {
		expect(gcpLogFilterChoice({ keep: false, runtimes: ["gke"] }, true).applicationLogs).toEqual(["gke"])
		expect(gcpLogFilterChoice({ keep: false, runtimes: [] }, true).applicationLogs).toEqual([])
		// The ticks are remembered while the filter is kept, and not asked for.
		expect(gcpLogFilterChoice({ keep: true, runtimes: ["gke"] }, true)).toEqual({
			keep: true,
			runtimes: ["gke"],
			applicationLogs: undefined,
		})
	})
})

describe("gcpApplicationLogsLine", () => {
	it("names the runtimes in display order, whatever order they were ticked in", () => {
		expect(gcpApplicationLogsLine(["gke", "cloud_run"])).toBe(
			"Platform logs and the output of Cloud Run, GKE containers",
		)
		expect(gcpApplicationLogsLine([])).toBe("Platform logs only, no application output")
	})

	it("has a name for every runtime the API takes", () => {
		expect(GCP_LOG_RUNTIMES.map(({ value }) => value)).toEqual([...GcpLogRuntime.literals])
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
