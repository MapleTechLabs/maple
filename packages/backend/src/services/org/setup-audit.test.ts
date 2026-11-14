import { describe, expect, it } from "vitest"
import type { AuditCheckResult } from "@maple/domain/setup-audit"
import {
	type ConfigAuditInputs,
	type SetupAuditInputs,
	type WarehouseAuditInputs,
	SETUP_AUDIT_CHECKS,
	classifyService,
	quoteSafely,
	runSetupAudit,
} from "./setup-audit"
import {
	buildIntegrationInventory,
	type IntegrationInventoryInputs,
} from "../integrations/integration-inventory"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0)
const HOUR = 60 * 60_000

/** A destination with no delivery failures recorded. */
const deliveringOk = { consecutiveFailures: 0, disabledAt: null, disabledReason: null }

/** A fully healthy org — every check passes. Each test perturbs exactly one field. */
const healthyConfig: ConfigAuditInputs = {
	telemetry: "present",
	alertRules: [
		{
			id: "rule-1",
			name: "API error rate",
			enabled: true,
			destinationIds: ["dest-1"],
			escalationChainIds: [],
			windowMinutes: 5,
			evaluationIntervalMinutes: 1,
			lastScheduledAt: NOW - 60_000,
			createdAt: NOW - 10 * 24 * HOUR,
		},
	],
	alertRuleStates: [{ ruleId: "rule-1", lastEvaluatedAt: NOW - 60_000, lastError: null }],
	alertDestinations: [
		{ id: "dest-1", name: "#alerts", enabled: true, lastTestError: null, ...deliveringOk },
	],
	errorNotificationPolicy: { enabled: true, destinationIds: ["dest-1"] },
	anomalyDetector: { enabled: true },
	dashboardCount: 2,
	samplingPolicy: null,
	attributeMappings: [],
	clickhouse: null,
	integrations: [{ provider: "cloudflare", revokedAt: null }],
	cloudflareAnalytics: [
		{
			dataset: "httpRequests",
			zoneName: "example.com",
			lastSuccessAt: NOW - 5 * 60_000,
			lastErrorAt: null,
			lastError: null,
		},
	],
	vcsRepositories: [{ id: "repo-1", fullName: "acme/api", syncStatus: "active", lastSyncError: null }],
	scrapeTargets: [{ id: "target-1", name: "api metrics", enabled: true, lastScrapeError: null }],
	openRecommendationCount: 0,
}

const spanKey = (key: string, usageCount = 100) => ({ scope: "span", key, usageCount })
const resourceKey = (key: string, usageCount = 100) => ({ scope: "resource", key, usageCount })

/** Rootless rows as the query returns them: each carries the org-wide totals of all the rows. */
const withOrgTotals = (
	rows: ReadonlyArray<{
		readonly entryService: string
		readonly traceCount: number
		readonly rootlessCount: number
		readonly sampledRootlessCount: number
		readonly externalParentCount?: number
	}>,
) => {
	const sum = (pick: (row: (typeof rows)[number]) => number) =>
		Arr.reduce(rows, 0, (total, row) => total + pick(row))
	const totals = {
		orgTraceCount: sum((row) => row.traceCount),
		orgRootlessCount: sum((row) => row.rootlessCount),
		orgSampledRootlessCount: sum((row) => row.sampledRootlessCount),
		orgExternalParentCount: sum((row) => row.externalParentCount ?? 0),
	}
	return Arr.map(rows, (row) => ({ externalParentCount: 0, ...row, ...totals }))
}

const healthyRule = Arr.getUnsafe(healthyConfig.alertRules, 0)

/** A fully healthy telemetry snapshot: every telemetry check passes against it. */
const healthyWarehouse: WarehouseAuditInputs = {
	lookbackHours: 24,
	logCorrelationHours: 6,
	attributeKeys: [
		spanKey("http.request.method"),
		spanKey("db.query.text"),
		resourceKey("service.version"),
		resourceKey("deployment.environment.name"),
		resourceKey("vcs.repository.url.full"),
		resourceKey("vcs.ref.head.revision"),
		{ scope: "log", key: "order.id", usageCount: 50 },
		{ scope: "log", key: "user.id", usageCount: 50 },
		{ scope: "log", key: "tenant.id", usageCount: 50 },
	],
	serviceUsage: [{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 40 }],
	spanShape: [
		{
			serviceName: "api",
			spanCount: 900,
			errorCount: 9,
			serverCount: 400,
			consumerCount: 0,
			noEnvCount: 0,
			spanNameCount: 30,
			badStatusCodes: [],
			badSpanKinds: [],
		},
	],
	logSeverity: [{ serviceName: "api", severityText: "INFO", logCount: 500 }],
	metricLabels: [{ attributeKey: "http.route", valueCardinality: 40 }],
	peerValues: [{ attributeKey: "peer.service", attributeValue: "tinybird", usageCount: 20 }],
	dbEdges: [{ serviceName: "api", dbSystem: "postgresql", dbNamespace: "orders", callCount: 100 }],
	logCorrelation: [
		{
			serviceName: "api",
			logCount: 500,
			uncorrelatedCount: 10,
			errorLogCount: 4,
			uncorrelatedErrorCount: 0,
		},
	],
	traceCompleteness: {
		windowMinutes: 60,
		traceSampleModulus: 1,
		orphans: [
			{
				serviceName: "api",
				childCount: 800,
				orphanCount: 4,
				sampledOrphanCount: 0,
				externalParentCount: 0,
				sampleTraceIds: [],
			},
		],
		rootless: withOrgTotals([
			{ entryService: "api", traceCount: 10_000, rootlessCount: 1, sampledRootlessCount: 0 },
		]),
		inboundRoutes: [],
	},
	services: [
		{ serviceName: "api", namespaces: [], environments: ["production"], sdkLanguages: ["nodejs"] },
	],
	resourceKeySamples: [],
	resourceKeyServices: [],
}

const healthyServiceSpans = Arr.getUnsafe(healthyWarehouse.spanShape, 0)

/** Overrides on top of the healthy telemetry snapshot. */
const warehouse = (overrides: Partial<WarehouseAuditInputs> = {}): WarehouseAuditInputs => ({
	...healthyWarehouse,
	...overrides,
})

const inputs = (config: Partial<ConfigAuditInputs> = {}): SetupAuditInputs => ({
	now: NOW,
	config: { ...healthyConfig, ...config },
	warehouse: healthyWarehouse,
})

/** Explicit-warehouse variant — a default parameter would swallow a deliberate `undefined`. */
const inputsWith = (
	warehouse: WarehouseAuditInputs | undefined,
	config: Partial<ConfigAuditInputs> = {},
): SetupAuditInputs => ({ now: NOW, config: { ...healthyConfig, ...config }, warehouse })

const check = (report: ReturnType<typeof runSetupAudit>, id: string): AuditCheckResult => {
	const found = Option.getOrUndefined(Arr.findFirst(report.checks, (row) => row.id === id))
	if (!found) throw new Error(`no check ${id} in report`)
	return found
}

describe("runSetupAudit — baseline", () => {
	it("passes every check for a healthy org", () => {
		const report = runSetupAudit(inputs())
		const failures = Arr.filter(report.checks, (row) => row.status !== "pass")
		expect(failures).toEqual([])
		expect(report.summary.pass).toBe(SETUP_AUDIT_CHECKS.length)
		expect(report.dataStatus).toBe("ok")
	})

	it("words every fix as something a person does, not an API call or agent tool", () => {
		const machineSpeak = Arr.filter(SETUP_AUDIT_CHECKS, (row) =>
			/\bMCP\b|\/v2\/|\b(?:GET|PATCH|POST|PUT)\s\/|_policy`/.test(row.fixHint),
		)
		expect(Arr.map(machineSpeak, (row) => row.id)).toEqual([])
	})

	it("uses unique check ids", () => {
		const ids = Arr.map(SETUP_AUDIT_CHECKS, (row) => row.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("agrees subject and verb in every finding sentence", () => {
		// Findings always lead with a count, so a hardcoded singular verb reads as "3 services
		// emits …". Drive every check to fail with both one and several affected items, then scan
		// each generated sentence. This is the guard that catches copy regressions in new checks.
		const failing = Arr.flatMap([1, 3], (n) => {
			const each = <T>(build: (index: number) => T) => Array.from({ length: n }, (_, i) => build(i))
			const config: ConfigAuditInputs = {
				...healthyConfig,
				alertRules: each((i) => ({
					...healthyRule,
					id: `rule-${i}`,
					name: `rule ${i}`,
					destinationIds: [],
					lastScheduledAt: NOW - 6 * HOUR,
				})),
				alertRuleStates: each((i) => ({
					ruleId: `rule-${i}`,
					lastEvaluatedAt: null,
					lastError: "boom",
				})),
				alertDestinations: each((i) => ({
					id: `dest-${i}`,
					name: `dest ${i}`,
					enabled: true,
					lastTestError: "boom",
					...deliveringOk,
				})),
				scrapeTargets: each((i) => ({
					id: `t-${i}`,
					name: `t${i}`,
					enabled: true,
					lastScrapeError: "boom",
				})),
				integrations: each((i) => ({ provider: `p${i}`, revokedAt: NOW })),
				vcsRepositories: each((i) => ({
					id: `r-${i}`,
					fullName: `acme/r${i}`,
					syncStatus: "error",
					lastSyncError: "401",
				})),
				cloudflareAnalytics: each((i) => ({
					dataset: `d${i}`,
					zoneName: null,
					lastSuccessAt: null,
					lastErrorAt: NOW,
					lastError: "403",
				})),
				attributeMappings: each((i) => ({
					id: `m-${i}`,
					name: `m${i}`,
					enabled: true,
					sourceContext: "span",
					sourceKey: `gone.key.${i}`,
					targetKey: "http.request.method",
					operation: "copy",
					updatedAt: NOW - 10 * 24 * HOUR,
				})),
			}
			const telemetry: WarehouseAuditInputs = {
				...healthyWarehouse,
				attributeKeys: [
					...each((i) => spanKey(`user.password.${i}`)),
					...each((i) => spanKey(`maple_reserved_${i}`)),
					resourceKey("env"),
					resourceKey("git.repo"),
				],
				serviceUsage: [
					{ serviceName: "api", logCount: 50_000, traceCount: 900, metricCount: 1 },
					...each((i) => ({
						serviceName: `svc-${i}`,
						logCount: 500,
						traceCount: 0,
						metricCount: 1,
					})),
					...each((i) => ({
						serviceName: `quiet-${i}`,
						logCount: 0,
						traceCount: 900,
						metricCount: 0,
					})),
				],
				spanShape: each((i) => ({
					serviceName: `svc-${i}`,
					spanCount: 900,
					errorCount: 0,
					serverCount: 0,
					consumerCount: 0,
					noEnvCount: 900,
					spanNameCount: 40_000,
					badStatusCodes: ["ERROR"],
					badSpanKinds: [],
				})),
				logSeverity: each((i) => ({
					serviceName: `svc-${i}`,
					severityText: "NOTICE",
					logCount: 90,
				})),
				metricLabels: each((i) => ({ attributeKey: `label-${i}`, valueCardinality: 90_000 })),
				peerValues: each((i) => [
					{ attributeKey: "peer.service", attributeValue: `dep${i}`, usageCount: 10 },
					{ attributeKey: "peer.service", attributeValue: `DEP${i}`, usageCount: 5 },
				]).flat(),
				dbEdges: each((i) => ({
					serviceName: `svc-${i}`,
					dbSystem: "redis",
					dbNamespace: "",
					callCount: 100,
				})),
				logCorrelation: each((i) => ({
					serviceName: `svc-${i}`,
					logCount: 500,
					uncorrelatedCount: 500,
					errorLogCount: 5,
					uncorrelatedErrorCount: 5,
				})),
				traceCompleteness: {
					windowMinutes: 60,
					traceSampleModulus: 1,
					orphans: each((i) => ({
						serviceName: `svc-${i}`,
						childCount: 800,
						orphanCount: 400,
						sampledOrphanCount: 0,
						externalParentCount: 0,
						sampleTraceIds: [],
					})),
					rootless: withOrgTotals([
						{ entryService: "api", traceCount: 800, rootlessCount: 0, sampledRootlessCount: 0 },
						...each((i) => ({
							entryService: `svc-${i}`,
							traceCount: 800,
							rootlessCount: 400,
							sampledRootlessCount: 0,
						})),
					]),
					inboundRoutes: [],
				},
			}
			return runSetupAudit({ now: NOW, config, warehouse: telemetry }).checks
		})

		// Every check must actually have produced a sentence, or the guard proves nothing.
		const sentences = Arr.filter(failing, (row) => row.status === "fail" && row.detail !== null)

		const singularVerbAfterPluralNoun =
			/\b\d+ [a-z][a-z .\-_*`]*s (is|has|emits|sends|receives|appears|uses|starts|logs|arrives|duplicates|marks)\b/
		for (const row of sentences) {
			expect(row.detail, `${row.id}: ${row.detail}`).not.toMatch(singularVerbAfterPluralNoun)
			// And the naive `+s` plural, which turns "dependency" into "dependencys". Consonant+`ys`
			// only, so real words ending in a vowel plus `ys` ("keys", "arrays") are left alone.
			expect(row.detail, `${row.id}: ${row.detail}`).not.toMatch(/[b-df-hj-np-tv-z]ys\b/)
		}
	})

	it("short-circuits to no_data before any check runs when telemetry never arrived", () => {
		// Deliberately also broken elsewhere: the gate must win over every other finding.
		const report = runSetupAudit(inputs({ telemetry: "absent", alertDestinations: [] }))
		expect(report.dataStatus).toBe("no_data")
		expect(report.checks).toEqual([])
		expect(report.summary).toEqual({ critical: 0, warn: 0, info: 0, pass: 0, skip: 0 })
	})

	it("runs the config checks when whether telemetry ever arrived is unknown", () => {
		const report = runSetupAudit(
			inputsWith(undefined, { telemetry: "unavailable", alertDestinations: [] }),
		)
		expect(report.dataStatus).toBe("ok")
		expect(check(report, "CFG-ALERT-01").status).toBe("fail")
		expect(check(report, "CFG-MAP-01").status).toBe("skip")
	})

	it("skips warehouse checks instead of failing them when the warehouse is unavailable", () => {
		const report = runSetupAudit(inputsWith(undefined))
		expect(report.warehouseAvailable).toBe(false)
		expect(check(report, "CFG-MAP-01").status).toBe("skip")
		expect(check(report, "CFG-MAP-02").status).toBe("skip")
		// Config checks still evaluate.
		expect(check(report, "CFG-ALERT-01").status).toBe("pass")
		// Exactly the telemetry-backed checks skip, and nothing else.
		const needsWarehouse = Arr.filter(SETUP_AUDIT_CHECKS, (row) => row.needsWarehouse === true)
		expect(report.summary.skip).toBe(needsWarehouse.length)
		expect(
			Arr.map(
				Arr.filter(report.checks, (row) => row.status === "skip"),
				(row) => row.id,
			),
		).toEqual(Arr.map(needsWarehouse, (row) => row.id))
	})

	it("counts each failure under its own severity", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [], // CFG-ALERT-01, CFG-ALERT-03 and CFG-NOTIF-01, all critical
				dashboardCount: 0, // CFG-DASH-01 info
			}),
		)
		expect(report.summary.critical).toBe(3)
		expect(report.summary.info).toBe(1)
		expect(
			report.summary.critical + report.summary.warn + report.summary.info + report.summary.pass,
		).toBe(SETUP_AUDIT_CHECKS.length)
	})
})

describe("CFG-ALERT-01 — a notification path exists", () => {
	it("fails when no destination is enabled", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{ id: "dest-1", name: "#alerts", enabled: false, lastTestError: null, ...deliveringOk },
				],
			}),
		)
		expect(check(report, "CFG-ALERT-01").status).toBe("fail")
	})
})

describe("CFG-ALERT-02 — alert rules exist", () => {
	it("fails when no rule is enabled and mentions that anomaly detection still covers shifts", () => {
		const report = runSetupAudit(inputs({ alertRules: [] }))
		const result = check(report, "CFG-ALERT-02")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("Anomaly detection is on")
	})

	it("hardens the message when anomaly detection is off too", () => {
		const report = runSetupAudit(inputs({ alertRules: [], anomalyDetector: { enabled: false } }))
		expect(check(report, "CFG-ALERT-02").detail).toContain("anomaly detection is also disabled")
	})

	it("treats a missing anomaly settings row as enabled", () => {
		const report = runSetupAudit(inputs({ alertRules: [], anomalyDetector: null }))
		expect(check(report, "CFG-ALERT-02").detail).toContain("Anomaly detection is on")
	})

	it("passes when a disabled rule sits alongside an enabled one", () => {
		const report = runSetupAudit(
			inputs({
				alertRules: [
					...healthyConfig.alertRules,
					{
						id: "rule-2",
						name: "retired",
						enabled: false,
						destinationIds: [],
						escalationChainIds: [],
						windowMinutes: 5,
						evaluationIntervalMinutes: 1,
						lastScheduledAt: null,
						createdAt: NOW - 10 * 24 * HOUR,
					},
				],
			}),
		)
		expect(check(report, "CFG-ALERT-02").status).toBe("pass")
		// A disabled rule with no destinations must not trip the routing check either.
		expect(check(report, "CFG-ALERT-03").status).toBe("pass")
	})
})

describe("CFG-ALERT-03 — rules route somewhere", () => {
	it("fails a rule with no destinations selected", () => {
		const report = runSetupAudit(inputs({ alertRules: [{ ...healthyRule, destinationIds: [] }] }))
		const result = check(report, "CFG-ALERT-03")
		expect(result.status).toBe("fail")
		expect(result.affected[0]).toMatchObject({
			kind: "alert_rule",
			id: "rule-1",
			note: "no destinations selected",
		})
	})

	it("fails a rule whose only destination was deleted", () => {
		const report = runSetupAudit(inputs({ alertRules: [{ ...healthyRule, destinationIds: ["gone"] }] }))
		expect(check(report, "CFG-ALERT-03").affected[0]?.note).toContain("disabled or deleted")
	})

	it("fails a rule whose only destination is disabled", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{ id: "dest-1", name: "#alerts", enabled: false, lastTestError: null, ...deliveringOk },
				],
			}),
		)
		expect(check(report, "CFG-ALERT-03").status).toBe("fail")
	})

	it("names the destinations Maple turned off when they were a rule's only route", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{
						id: "dest-1",
						name: "#alerts",
						enabled: false,
						lastTestError: null,
						consecutiveFailures: 5,
						disabledAt: NOW - HOUR,
						disabledReason: "404 no_service",
					},
				],
			}),
		)
		const result = check(report, "CFG-ALERT-03")
		expect(result.severity).toBe("critical")
		expect(result.affected[0]?.note).toBe(
			"every selected destination is off; Maple turned off #alerts (404 no_service)",
		)
	})

	it("passes a rule with no destinations whose tier starts an escalation chain", () => {
		const report = runSetupAudit(
			inputs({ alertRules: [{ ...healthyRule, destinationIds: [], escalationChainIds: ["chain-1"] }] }),
		)
		expect(check(report, "CFG-ALERT-03").status).toBe("pass")
	})

	it("passes when at least one selected destination is live", () => {
		const report = runSetupAudit(
			inputs({ alertRules: [{ ...healthyRule, destinationIds: ["gone", "dest-1"] }] }),
		)
		expect(check(report, "CFG-ALERT-03").status).toBe("pass")
	})

	it("caps the affected list at 20 while reporting the true total", () => {
		const many = Array.from({ length: 25 }, (_, index) => ({
			id: `rule-${index}`,
			name: `rule ${index}`,
			enabled: true,
			destinationIds: [],
			escalationChainIds: [],
			windowMinutes: 5,
			evaluationIntervalMinutes: 1,
			lastScheduledAt: NOW - 60_000,
			createdAt: NOW - 10 * 24 * HOUR,
		}))
		const result = check(runSetupAudit(inputs({ alertRules: many })), "CFG-ALERT-03")
		expect(result.affected).toHaveLength(20)
		expect(result.affectedCount).toBe(25)
	})
})

describe("CFG-ALERT-04 — destinations delivered on last test", () => {
	it("fails an enabled destination whose last test errored", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{
						id: "dest-1",
						name: "#alerts",
						enabled: true,
						lastTestError: "404 from Slack webhook",
						...deliveringOk,
					},
				],
			}),
		)
		const result = check(report, "CFG-ALERT-04")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("last test failed: 404 from Slack webhook")
	})

	it("truncates a pathologically long provider error", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{
						id: "dest-1",
						name: "#alerts",
						enabled: true,
						lastTestError: Str.repeat(500)("x"),
						...deliveringOk,
					},
				],
			}),
		)
		const note = check(report, "CFG-ALERT-04").affected[0]?.note ?? ""
		expect(note).toBe(`last test failed: ${Str.repeat(159)("x")}…`)
	})

	it("ignores a disabled destination that failed its test", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{ id: "dest-1", name: "#alerts", enabled: true, lastTestError: null, ...deliveringOk },
					{ id: "dest-2", name: "old", enabled: false, lastTestError: "boom", ...deliveringOk },
				],
			}),
		)
		expect(check(report, "CFG-ALERT-04").status).toBe("pass")
	})

	it("never fires just because a destination was never tested", () => {
		const report = runSetupAudit(inputs())
		expect(check(report, "CFG-ALERT-04").status).toBe("pass")
	})

	it("reports a destination Maple turned off after failed deliveries, with its reason", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					...healthyConfig.alertDestinations,
					{
						id: "dest-2",
						name: "pager",
						enabled: false,
						lastTestError: null,
						consecutiveFailures: 5,
						disabledAt: NOW - 3 * HOUR,
						disabledReason: "403 channel_not_found",
					},
				],
			}),
		)
		const result = check(report, "CFG-ALERT-04")
		expect(result.status).toBe("fail")
		expect(result.affected[0]).toMatchObject({
			id: "dest-2",
			note: "turned off by Maple 3 hours ago: 403 channel_not_found",
		})
	})

	it("reports real delivery failures on an enabled destination nobody tested", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{
						id: "dest-1",
						name: "#alerts",
						enabled: true,
						lastTestError: null,
						...deliveringOk,
						consecutiveFailures: 2,
					},
				],
			}),
		)
		expect(check(report, "CFG-ALERT-04").affected[0]?.note).toBe("2 deliveries in a row failed")
	})

	it("stays quiet on a single transient delivery failure", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{
						id: "dest-1",
						name: "#alerts",
						enabled: true,
						lastTestError: null,
						...deliveringOk,
						consecutiveFailures: 1,
					},
				],
			}),
		)
		expect(check(report, "CFG-ALERT-04").status).toBe("pass")
	})

	it("reports why Maple turned a destination off when its last recipient left", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{
						id: "dest-1",
						name: "email",
						enabled: false,
						lastTestError: null,
						consecutiveFailures: 0,
						disabledAt: NOW - HOUR,
						disabledReason: "Last recipient left the organization",
					},
				],
			}),
		)
		expect(check(report, "CFG-ALERT-04").detail).not.toContain("failures")
		expect(check(report, "CFG-ALERT-03").affected[0]?.note).toBe(
			"every selected destination is off; Maple turned off email (Last recipient left the organization)",
		)
	})
})

describe("CFG-ALERT-05 — rules are evaluating", () => {
	it("reports an evaluation error from the rule state", () => {
		const report = runSetupAudit(
			inputs({
				alertRuleStates: [{ ruleId: "rule-1", lastEvaluatedAt: NOW, lastError: "query timed out" }],
			}),
		)
		const result = check(report, "CFG-ALERT-05")
		expect(result.severity).toBe("critical")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("evaluation error: query timed out")
	})

	it("flags a rule that has never been scheduled once past the grace period", () => {
		const report = runSetupAudit(
			inputs({
				alertRules: [{ ...healthyRule, lastScheduledAt: null, createdAt: NOW - 3 * HOUR }],
				alertRuleStates: [],
			}),
		)
		expect(check(report, "CFG-ALERT-05").affected[0]?.note).toBe("never evaluated")
	})

	it("gives a freshly created rule its grace period", () => {
		const report = runSetupAudit(
			inputs({
				alertRules: [{ ...healthyRule, lastScheduledAt: null, createdAt: NOW - 10 * 60_000 }],
				alertRuleStates: [],
			}),
		)
		expect(check(report, "CFG-ALERT-05").status).toBe("pass")
	})

	it("flags a rule whose scheduler claim has gone stale", () => {
		const report = runSetupAudit(
			inputs({ alertRules: [{ ...healthyRule, lastScheduledAt: NOW - 4 * HOUR }] }),
		)
		expect(check(report, "CFG-ALERT-05").affected[0]?.note).toBe("last evaluated 4 hours ago")
	})

	it("tolerates a claim that is merely a few minutes old", () => {
		const report = runSetupAudit(
			inputs({ alertRules: [{ ...healthyRule, lastScheduledAt: NOW - 10 * 60_000 }] }),
		)
		expect(check(report, "CFG-ALERT-05").status).toBe("pass")
	})

	const hourlyRule = (lastScheduledAt: number) => ({
		...healthyRule,
		windowMinutes: 60,
		evaluationIntervalMinutes: 60,
		lastScheduledAt,
	})

	it("passes an hourly rule claimed 47 minutes ago", () => {
		const report = runSetupAudit(inputs({ alertRules: [hourlyRule(NOW - 47 * 60_000)] }))
		expect(check(report, "CFG-ALERT-05").status).toBe("pass")
	})

	it("flags an hourly rule that missed two intervals", () => {
		const report = runSetupAudit(inputs({ alertRules: [hourlyRule(NOW - 3 * HOUR)] }))
		expect(check(report, "CFG-ALERT-05").affected[0]?.note).toBe("last evaluated 3 hours ago")
	})

	it("flags a 5-minute rule claimed 45 minutes ago", () => {
		const report = runSetupAudit(
			inputs({
				alertRules: [
					{
						...healthyRule,
						evaluationIntervalMinutes: 5,
						lastScheduledAt: NOW - 45 * 60_000,
					},
				],
			}),
		)
		expect(check(report, "CFG-ALERT-05").affected[0]?.note).toBe("last evaluated 45 minutes ago")
	})
})

describe("CFG-NOTIF-01 — error notifications reach someone", () => {
	it("fails when the policy is explicitly disabled", () => {
		const report = runSetupAudit(
			inputs({ errorNotificationPolicy: { enabled: false, destinationIds: ["dest-1"] } }),
		)
		const result = check(report, "CFG-NOTIF-01")
		expect(result.detail).toContain("turned off")
		expect(result.severity).toBe("critical")
	})

	it("fails when enabled with no destinations", () => {
		const report = runSetupAudit(
			inputs({ errorNotificationPolicy: { enabled: true, destinationIds: [] } }),
		)
		expect(check(report, "CFG-NOTIF-01").detail).toContain("no destination is selected")
	})

	it("fails when every selected destination is gone", () => {
		const report = runSetupAudit(
			inputs({ errorNotificationPolicy: { enabled: true, destinationIds: ["gone"] } }),
		)
		expect(check(report, "CFG-NOTIF-01").detail).toContain("disabled or deleted")
	})

	it("treats a missing policy row as enabled-but-unrouted", () => {
		// The table defaults to enabled with an empty destination list, so an org that never opened
		// the settings page has error notifications on that deliver nowhere.
		const report = runSetupAudit(inputs({ errorNotificationPolicy: null }))
		expect(check(report, "CFG-NOTIF-01").detail).toContain("no destination is selected")
	})
})

describe("CFG-ANOM-01 — anomaly detection", () => {
	it("fires only on an explicit opt-out", () => {
		expect(
			check(runSetupAudit(inputs({ anomalyDetector: { enabled: false } })), "CFG-ANOM-01").status,
		).toBe("fail")
		expect(check(runSetupAudit(inputs({ anomalyDetector: null })), "CFG-ANOM-01").status).toBe("pass")
	})
})

describe("CFG-SAMP-01 — sampling is understood", () => {
	it("passes at a ratio of exactly 1", () => {
		const report = runSetupAudit(
			inputs({
				samplingPolicy: {
					traceSampleRatio: 1,
					alwaysKeepErrorSpans: true,
					alwaysKeepSlowSpansMs: null,
				},
			}),
		)
		expect(check(report, "CFG-SAMP-01").status).toBe("pass")
	})

	it("passes when no policy row exists", () => {
		expect(check(runSetupAudit(inputs({ samplingPolicy: null })), "CFG-SAMP-01").status).toBe("pass")
	})

	it("reports the ratio as a percentage and notes that errors are kept", () => {
		const report = runSetupAudit(
			inputs({
				samplingPolicy: {
					traceSampleRatio: 0.1,
					alwaysKeepErrorSpans: true,
					alwaysKeepSlowSpansMs: null,
				},
			}),
		)
		const result = check(report, "CFG-SAMP-01")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("keeps 10% of traces")
		expect(result.detail).toContain("Error spans are always kept.")
	})

	it("warns harder when error spans are sampled too", () => {
		const report = runSetupAudit(
			inputs({
				samplingPolicy: {
					traceSampleRatio: 0.05,
					alwaysKeepErrorSpans: false,
					alwaysKeepSlowSpansMs: null,
				},
			}),
		)
		expect(check(report, "CFG-SAMP-01").detail).toContain("errors can be missed entirely")
	})
})

describe("CFG-ATTR-01 — open recommendations rollup", () => {
	it("reports the count without re-listing the recommendations", () => {
		const report = runSetupAudit(inputs({ openRecommendationCount: 3 }))
		const result = check(report, "CFG-ATTR-01")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("3 open instrumentation recommendations")
		expect(result.affected).toEqual([])
		expect(report.openRecommendationCount).toBe(3)
	})

	it("singularizes a lone recommendation", () => {
		const report = runSetupAudit(inputs({ openRecommendationCount: 1 }))
		expect(check(report, "CFG-ATTR-01").detail).toContain("1 open instrumentation recommendation —")
	})
})

describe("CFG-MAP-01 / CFG-MAP-02 — mapping liveness", () => {
	const mapping = {
		id: "map-1",
		name: "legacy status code",
		enabled: true,
		sourceContext: "span",
		sourceKey: "http.status_code",
		targetKey: "http.response.status_code",
		operation: "copy",
		updatedAt: NOW - 10 * 24 * HOUR,
	}
	const move = { ...mapping, operation: "move" }

	it("flags a mapping whose source key no longer arrives", () => {
		const report = runSetupAudit(inputs({ attributeMappings: [mapping] }))
		const result = check(report, "CFG-MAP-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("http.status_code no longer arrives")
		expect(result.detail).toContain("last 24h")
	})

	it("passes while the source key is still arriving", () => {
		const report = runSetupAudit(
			inputsWith(warehouse({ attributeKeys: [spanKey("http.status_code", 9)] }), {
				attributeMappings: [mapping],
			}),
		)
		expect(check(report, "CFG-MAP-01").status).toBe("pass")
	})

	it("ignores a disabled or resource-scoped mapping", () => {
		const report = runSetupAudit(
			inputs({
				attributeMappings: [
					{ ...mapping, enabled: false },
					{ ...mapping, id: "map-2", sourceContext: "resource" },
				],
			}),
		)
		expect(check(report, "CFG-MAP-01").status).toBe("pass")
	})

	it("passes a working copy or move mapping, whose target the mapping itself writes", () => {
		const copyReport = runSetupAudit(
			inputsWith(
				warehouse({
					attributeKeys: [spanKey("http.status_code", 9), spanKey("http.response.status_code", 9)],
				}),
				{ attributeMappings: [mapping] },
			),
		)
		expect(check(copyReport, "CFG-MAP-02").status).toBe("pass")
		const moveReport = runSetupAudit(
			inputsWith(warehouse({ attributeKeys: [spanKey("http.response.status_code", 9)] }), {
				attributeMappings: [move],
			}),
		)
		expect(check(moveReport, "CFG-MAP-01").status).toBe("pass")
		expect(check(moveReport, "CFG-MAP-02").status).toBe("pass")
	})

	it("does not flag a move changed inside the lookback, while older spans keep the source", () => {
		const report = runSetupAudit(
			inputsWith(
				warehouse({
					attributeKeys: [spanKey("http.status_code", 9), spanKey("http.response.status_code", 9)],
				}),
				{ attributeMappings: [{ ...move, updatedAt: NOW - HOUR }] },
			),
		)
		expect(check(report, "CFG-MAP-02").status).toBe("pass")
	})

	it("flags a move mapping whose source survives because the target already arrives", () => {
		const report = runSetupAudit(
			inputsWith(
				warehouse({
					attributeKeys: [spanKey("http.status_code", 9), spanKey("http.response.status_code", 9)],
				}),
				{ attributeMappings: [move] },
			),
		)
		const result = check(report, "CFG-MAP-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("http.response.status_code already arrives natively")
	})
})

describe("CFG-BYOC-01 / CFG-BYOC-02 — bring-your-own ClickHouse", () => {
	const settings = {
		syncStatus: "connected",
		lastSyncError: null,
		schemaVersion: "0007",
		expectedSchemaVersion: "0007",
	}

	it("passes both checks for a managed (non-BYO) org", () => {
		const report = runSetupAudit(inputs({ clickhouse: null }))
		expect(check(report, "CFG-BYOC-01").status).toBe("pass")
		expect(check(report, "CFG-BYOC-02").status).toBe("pass")
	})

	it("fails when the connection is in an error state", () => {
		const report = runSetupAudit(
			inputs({ clickhouse: { ...settings, syncStatus: "error", lastSyncError: "connect ETIMEDOUT" } }),
		)
		const result = check(report, "CFG-BYOC-01")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("connect ETIMEDOUT")
	})

	it("fails when the applied schema is behind the bundled version", () => {
		const report = runSetupAudit(inputs({ clickhouse: { ...settings, schemaVersion: "0005" } }))
		expect(check(report, "CFG-BYOC-02").detail).toContain("0005")
	})

	it("names an unapplied schema explicitly", () => {
		const report = runSetupAudit(inputs({ clickhouse: { ...settings, schemaVersion: null } }))
		expect(check(report, "CFG-BYOC-02").detail).toContain("an unrecognized version")
	})

	it("abbreviates a project-revision hash left behind by older code", () => {
		const report = runSetupAudit(
			inputs({ clickhouse: { ...settings, schemaVersion: "4d5d918315933608d316aa8d6e6b5794" } }),
		)
		const detail = check(report, "CFG-BYOC-02").detail ?? ""
		expect(detail).toContain("an unrecognized version (4d5d9183…)")
		expect(detail).not.toContain("d316aa8d")
	})
})

describe("integration checks", () => {
	it("CFG-INTEG-01 flags a revoked connection", () => {
		const report = runSetupAudit(
			inputs({ integrations: [{ provider: "cloudflare", revokedAt: NOW - HOUR }] }),
		)
		const result = check(report, "CFG-INTEG-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]).toMatchObject({ kind: "integration", name: "cloudflare" })
	})

	describe("inventory-backed integration checks", () => {
		const inventoryOf = (partial: Partial<IntegrationInventoryInputs>) =>
			buildIntegrationInventory(
				{
					oauthConnections: [],
					vcsInstallations: [],
					vcsRepositories: [],
					cloudflareStates: [],
					cloudflareLogpush: [],
					cloudflareHyperdrives: [],
					gcpConnectors: [],
					gcpResourceCounts: [],
					awsConnections: [],
					supabaseConnection: null,
					supabaseProjects: [],
					railwayConnection: null,
					railwayEnvironments: [],
					vercelConnection: null,
					vercelProjectCount: 0,
					planetscaleConnection: null,
					planetscaleDatabases: [],
					planetscalePollStates: [],
					scrapeTargets: [],
					chatWorkspaces: [],
					searchConsoleSites: [],
					...partial,
				},
				NOW,
			)
		const railwayConnection = {
			workspaceNames: "acme",
			authFailedAt: null,
			lastSuccessAt: NOW - 60_000,
			lastErrorAt: null,
			lastError: null,
			createdAt: NOW - 30 * 24 * HOUR,
		}

		it("CFG-INTEG-04 names a stale Railway environment and how old its data is", () => {
			const report = runSetupAudit(
				inputs({
					integrationInventory: inventoryOf({
						railwayConnection,
						railwayEnvironments: [
							{
								projectName: "shop",
								environmentName: "preview",
								serviceCount: 2,
								lastSuccessAt: NOW - 4 * HOUR,
								lastErrorAt: null,
								lastError: null,
							},
						],
					}),
				}),
			)
			const result = check(report, "CFG-INTEG-04")
			expect(result.status).toBe("fail")
			expect(result.affected[0]?.name).toBe("environment shop / preview")
			expect(result.affected[0]?.note).toBe("no successful update for 4 hours")
		})

		it("CFG-INTEG-04 reports a rejected Railway token even with no environments", () => {
			const report = runSetupAudit(
				inputs({
					integrationInventory: inventoryOf({
						railwayConnection: { ...railwayConnection, authFailedAt: NOW - HOUR },
					}),
				}),
			)
			const result = check(report, "CFG-INTEG-04")
			expect(result.status).toBe("fail")
			expect(result.affected[0]?.note).toContain("Railway rejected the API token")
		})

		it("CFG-INTEG-05 flags a PlanetScale grant waiting for an organization, but not a revoked one", () => {
			const grant = {
				provider: "planetscale",
				externalAccountName: "acme",
				externalUserEmail: null,
				revokedAt: null,
				createdAt: NOW - HOUR,
			}
			const pending = runSetupAudit(
				inputs({ integrationInventory: inventoryOf({ oauthConnections: [grant] }) }),
			)
			expect(check(pending, "CFG-INTEG-05").affected[0]?.note).toContain(
				"no PlanetScale organization is selected",
			)

			// A revoked grant is CFG-INTEG-01's finding; reporting it twice would double-count one problem.
			const revoked = runSetupAudit(
				inputs({
					integrationInventory: inventoryOf({
						oauthConnections: [{ ...grant, revokedAt: NOW - HOUR }],
					}),
				}),
			)
			expect(check(revoked, "CFG-INTEG-05").status).toBe("pass")
		})

		const planetscaleConnection = {
			psOrganization: "acme",
			detectedPermissions: { readDatabases: true, readOrganization: true },
			lastInventoryAt: NOW - 30 * 60_000,
			lastInventoryError: null,
			createdAt: NOW - 30 * 24 * HOUR,
		}
		const planetscaleDatabase = {
			databaseId: "db-1",
			name: "maple",
			kind: "postgresql",
			region: "us-east",
			state: "ready",
		}
		const neverPolled = { databaseId: "db-1", lastSuccessAt: null, lastErrorAt: null, lastError: null }

		it("CFG-INTEG-05 says a database never polled, instead of quoting its metadata as an error", () => {
			const report = runSetupAudit(
				inputs({
					integrationInventory: inventoryOf({
						planetscaleConnection,
						planetscaleDatabases: [planetscaleDatabase],
						planetscalePollStates: [neverPolled],
					}),
				}),
			)
			const result = check(report, "CFG-INTEG-05")
			expect(result.affected).toEqual([
				{ kind: "integration", name: "database maple", note: "never polled successfully yet" },
			])
			expect(result.fixHint).not.toContain("organization")
		})

		it("CFG-INTEG-05 gives a database on a connection under an hour old time for its first poll", () => {
			const report = runSetupAudit(
				inputs({
					integrationInventory: inventoryOf({
						planetscaleConnection: { ...planetscaleConnection, createdAt: NOW - 20 * 60_000 },
						planetscaleDatabases: [planetscaleDatabase],
						planetscalePollStates: [neverPolled],
					}),
				}),
			)
			expect(check(report, "CFG-INTEG-05").status).toBe("pass")
		})

		it("CFG-INTEG-05 reports a missing permission alongside failing databases, with a reconnect fix", () => {
			const report = runSetupAudit(
				inputs({
					integrationInventory: inventoryOf({
						planetscaleConnection: {
							...planetscaleConnection,
							detectedPermissions: { readDatabases: false, readOrganization: true },
						},
						planetscaleDatabases: [planetscaleDatabase],
						planetscalePollStates: [
							{ ...neverPolled, lastErrorAt: NOW - 60_000, lastError: "401 unauthorized" },
						],
					}),
				}),
			)
			const result = check(report, "CFG-INTEG-05")
			expect(Arr.map(result.affected, (entity) => entity.note)).toEqual([
				expect.stringContaining("The grant lacks readDatabases"),
				"401 unauthorized",
			])
			expect(result.fixHint).toContain("reconnect PlanetScale")
		})

		it("CFG-INTEG-05 tells an org with no PlanetScale organization selected to pick one", () => {
			const report = runSetupAudit(
				inputs({
					integrationInventory: inventoryOf({
						oauthConnections: [
							{
								provider: "planetscale",
								externalAccountName: "acme",
								externalUserEmail: null,
								revokedAt: null,
								createdAt: NOW - 2 * HOUR,
							},
						],
					}),
				}),
			)
			expect(check(report, "CFG-INTEG-05").fixHint).toContain("pick the PlanetScale organization")
		})

		it("CFG-INTEG-06 fails only on a Logpush job that errored, not one still waiting for traffic", () => {
			const logpush = {
				name: "edge-logs",
				zoneName: "example.com",
				serviceName: "edge",
				lastReceivedAt: null,
			}
			const waiting = runSetupAudit(
				inputs({
					integrationInventory: inventoryOf({
						cloudflareLogpush: [{ ...logpush, lastError: null }],
					}),
				}),
			)
			expect(check(waiting, "CFG-INTEG-06").status).toBe("pass")

			const broken = runSetupAudit(
				inputs({
					integrationInventory: inventoryOf({
						cloudflareLogpush: [{ ...logpush, lastError: "HMAC signature mismatch" }],
					}),
				}),
			)
			const result = check(broken, "CFG-INTEG-06")
			expect(result.status).toBe("fail")
			expect(result.affected[0]?.note).toContain("HMAC signature mismatch")
		})

		it("CFG-INTEG-07 reports a rejected Vercel token and an errored drain", () => {
			const vercelConnection = {
				teamName: "acme",
				authFailedAt: null,
				logsEnabled: true,
				tracesEnabled: true,
				aiGatewayEnabled: true,
				speedInsightsEnabled: false,
				webAnalyticsEnabled: false,
				auditLogEnabled: false,
				logDrainState: { status: "enabled", lastError: null },
				traceDrainState: { status: "errored", lastError: "limits-exceeded" },
				aiGatewayDrainState: { status: "enabled", lastError: null },
				speedInsightsDrainState: null,
				webAnalyticsDrainState: null,
				auditLogDrainState: null,
				lastSuccessAt: NOW - 60_000,
				lastErrorAt: null,
				lastError: null,
				createdAt: NOW - 30 * 24 * HOUR,
			}
			const errored = check(
				runSetupAudit(inputs({ integrationInventory: inventoryOf({ vercelConnection }) })),
				"CFG-INTEG-07",
			)
			expect(errored.status).toBe("fail")
			expect(errored.affected).toEqual([
				{ kind: "integration", name: "drain traces", note: "limits-exceeded" },
			])
			const rejected = check(
				runSetupAudit(
					inputs({
						integrationInventory: inventoryOf({
							vercelConnection: {
								...vercelConnection,
								authFailedAt: NOW - HOUR,
								traceDrainState: { status: "enabled", lastError: null },
							},
						}),
					}),
				),
				"CFG-INTEG-07",
			)
			expect(
				Arr.some(rejected.affected, (entity) =>
					Str.includes("Vercel rejected the access token")(entity.note ?? ""),
				),
			).toBe(true)
		})

		it("passes the inventory checks when the inventory could not be read", () => {
			const report = runSetupAudit(inputs())
			for (const id of ["CFG-INTEG-04", "CFG-INTEG-05", "CFG-INTEG-06"]) {
				expect(check(report, id).status).toBe("pass")
			}
		})
	})

	it("CFG-INTEG-02 fires only when the last error is newer than the last success", () => {
		const stale = runSetupAudit(
			inputs({
				cloudflareAnalytics: [
					{
						dataset: "httpRequests",
						zoneName: "example.com",
						lastSuccessAt: NOW - 60_000,
						lastErrorAt: NOW - 10 * HOUR,
						lastError: "old blip",
					},
				],
			}),
		)
		expect(check(stale, "CFG-INTEG-02").status).toBe("pass")

		const broken = runSetupAudit(
			inputs({
				cloudflareAnalytics: [
					{
						dataset: "firewallEvents",
						zoneName: null,
						lastSuccessAt: NOW - 10 * HOUR,
						lastErrorAt: NOW - 60_000,
						lastError: "403 from Cloudflare GraphQL",
					},
				],
			}),
		)
		const result = check(broken, "CFG-INTEG-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("firewallEvents")
	})

	it("CFG-INTEG-02 folds one error stamped across many zones into a single finding", () => {
		const zones = Arr.makeBy(17, (i) => ({
			dataset: "firewall_events",
			zoneName: `zone-${i}.dev`,
			lastSuccessAt: NOW - 2 * 24 * HOUR,
			lastErrorAt: NOW - 3 * HOUR,
			lastError: "Token refresh failed with 500",
		}))
		const result = check(runSetupAudit(inputs({ cloudflareAnalytics: zones })), "CFG-INTEG-02")
		expect(result.detail).toContain("17 Cloudflare datasets")
		// One row per group (the detail carries the dataset count); two days without a poll is data loss.
		expect(result.affectedCount).toBe(1)
		expect(result.severity).toBe("critical")
		expect(result.detail).toContain("all for over 24 hours, so that data is missing")
		expect(result.affected).toEqual([
			{
				kind: "integration",
				name: "firewall_events on 17 zones",
				note: "last success 2 days ago; Token refresh failed with 500 (3 hours ago)",
			},
		])
		expect(result.fixHint).toContain("reconnect the Cloudflare integration in Sources now")
	})

	it("CFG-INTEG-02 masks credentials quoted in a stored provider error", () => {
		const result = check(
			runSetupAudit(
				inputs({
					cloudflareAnalytics: [
						{
							dataset: "httpRequests",
							zoneName: "example.com",
							lastSuccessAt: NOW - 3 * HOUR,
							lastErrorAt: NOW - HOUR,
							lastError: "401 from upstream: Authorization: Bearer abc123secretvalue",
						},
					],
				}),
			),
			"CFG-INTEG-02",
		)
		expect(result.affected[0]?.note).toContain("Authorization: [redacted]")
		expect(result.affected[0]?.note).not.toContain("abc123secretvalue")
	})

	it("CFG-INTEG-02 stays a warning while the last success is under a day old", () => {
		const result = check(
			runSetupAudit(
				inputs({
					cloudflareAnalytics: [
						{
							dataset: "httpRequests",
							zoneName: "example.com",
							lastSuccessAt: NOW - 3 * HOUR,
							lastErrorAt: NOW - HOUR,
							lastError: "502",
						},
					],
				}),
			),
			"CFG-INTEG-02",
		)
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("warn")
	})

	it("CFG-INTEG-02 treats a never-successful dataset that errored as failing", () => {
		const report = runSetupAudit(
			inputs({
				cloudflareAnalytics: [
					{
						dataset: "workersInvocations",
						zoneName: null,
						lastSuccessAt: null,
						lastErrorAt: NOW - 60_000,
						lastError: "missing permission",
					},
				],
			}),
		)
		const result = check(report, "CFG-INTEG-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("missing permission (1 minute ago), never succeeded")
	})

	it.each([{ enabled: false }, { enabled: true, maxDuration: 0 }])(
		"CFG-INTEG-02 lists unavailable settings %j without counting a stale error as failed",
		(settings) => {
			const state = {
				dataset: "firewall_events",
				zoneName: "example.com",
				lastSuccessAt: null,
				lastErrorAt: NOW - HOUR,
				lastError: "OAuth request timed out",
				settingsJson: JSON.stringify(settings),
			}
			const result = check(runSetupAudit(inputs({ cloudflareAnalytics: [state] })), "CFG-INTEG-02")
			expect(result.status).toBe("pass")
			expect(result.detail).toContain("unavailable")
			expect(result.affected).toEqual([
				expect.objectContaining({
					name: "firewall_events · example.com",
					note: expect.stringContaining("unavailable"),
				}),
			])
		},
	)

	it("CFG-INTEG-02 keeps available failures failing alongside unavailable datasets", () => {
		const state = {
			dataset: "firewall_events",
			zoneName: "example.com",
			lastSuccessAt: null,
			lastErrorAt: NOW - HOUR,
			lastError: "real upstream error",
		}
		const result = check(
			runSetupAudit(
				inputs({
					cloudflareAnalytics: [
						{ ...state, settingsJson: JSON.stringify({ enabled: false }) },
						{
							...state,
							dataset: "http_requests",
							settingsJson: JSON.stringify({ enabled: true, maxDuration: 3600 }),
						},
					],
				}),
			),
			"CFG-INTEG-02",
		)
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("1 Cloudflare dataset has failed")
		expect(result.detail).toContain("1 unavailable")
		expect(result.affected).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "http_requests · example.com",
					// The grouped note leads with the error and appends the success age.
					note: expect.stringContaining("real upstream error"),
				}),
				expect.objectContaining({
					name: "firewall_events · example.com",
					note: expect.stringContaining("unavailable"),
				}),
			]),
		)
	})

	it.each([null, "invalid json", "{}", '{"enabled":"false"}', '{"maxDuration":null}'])(
		"CFG-INTEG-02 does not suppress an error for unknown settings %s",
		(settingsJson) => {
			const result = check(
				runSetupAudit(
					inputs({
						cloudflareAnalytics: [
							{
								dataset: "http_requests",
								zoneName: null,
								lastSuccessAt: null,
								lastErrorAt: NOW - HOUR,
								lastError: "real error",
								settingsJson,
							},
						],
					}),
				),
				"CFG-INTEG-02",
			)
			expect(result.status).toBe("fail")
		},
	)

	it("CFG-INTEG-03 flags a repository whose sync errored", () => {
		const report = runSetupAudit(
			inputs({
				vcsRepositories: [
					{
						id: "repo-1",
						fullName: "acme/api",
						syncStatus: "error",
						lastSyncError: "401 from GitHub",
					},
				],
			}),
		)
		expect(check(report, "CFG-INTEG-03").affected[0]?.name).toBe("acme/api")
	})

	it("CFG-SCRAPE-01 ignores disabled targets", () => {
		const report = runSetupAudit(
			inputs({
				scrapeTargets: [
					{ id: "target-1", name: "old", enabled: false, lastScrapeError: "connection refused" },
				],
			}),
		)
		expect(check(report, "CFG-SCRAPE-01").status).toBe("pass")
	})

	it("CFG-SCRAPE-01 flags an enabled target that failed its last scrape", () => {
		const report = runSetupAudit(
			inputs({
				scrapeTargets: [
					{
						id: "target-1",
						name: "api metrics",
						enabled: true,
						lastScrapeError: "connection refused",
					},
				],
			}),
		)
		const result = check(report, "CFG-SCRAPE-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("connection refused")
	})

	it("never fires on the absence of an optional integration", () => {
		const report = runSetupAudit(
			inputs({ integrations: [], cloudflareAnalytics: [], vcsRepositories: [], scrapeTargets: [] }),
		)
		for (const id of ["CFG-INTEG-01", "CFG-INTEG-02", "CFG-INTEG-03", "CFG-SCRAPE-01"]) {
			expect(check(report, id).status).toBe("pass")
		}
	})
})

/** Runs the audit against a perturbed telemetry snapshot, with configuration left healthy. */
const telemetry = (overrides: Partial<WarehouseAuditInputs>) =>
	runSetupAudit(inputsWith(warehouse(overrides)))

describe("RES-01 — service.name is set", () => {
	it("flags the SDK's default identity", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "unknown_service:node", logCount: 0, traceCount: 40, metricCount: 0 },
			],
		})
		const result = check(report, "RES-01")
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("critical")
		expect(result.affected[0]?.name).toBe("unknown_service:node")
	})
})

describe("ING-01 — service names agree across signals", () => {
	it("flags a name that appears in logs but never in traces", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 40 },
				{ serviceName: "api-server", logCount: 300, traceCount: 0, metricCount: 0 },
			],
		})
		const result = check(report, "ING-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]).toMatchObject({
			name: "api-server",
			note: 'logs only; traces arrive as "api"',
		})
	})

	it("ignores a logs-only service with no traced twin: it logs without a tracer", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "maple-api", logCount: 500, traceCount: 900, metricCount: 40 },
				{ serviceName: "maple-sandbox", logCount: 300, traceCount: 0, metricCount: 0 },
				{ serviceName: "maple-api-pr-2408", logCount: 30, traceCount: 0, metricCount: 0 },
			],
		})
		expect(check(report, "ING-01").status).toBe("pass")
	})

	it("ignores metrics-only names — scraped exporters legitimately never trace", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 40 },
				{ serviceName: "cloudflare/example.com", logCount: 0, traceCount: 0, metricCount: 12 },
				{ serviceName: "node-cadvisor", logCount: 0, traceCount: 0, metricCount: 900 },
			],
		})
		expect(check(report, "ING-01").status).toBe("pass")
	})

	it("leaves an unnamed service to RES-01 rather than reporting it as a mismatch", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 40 },
				{ serviceName: "", logCount: 300, traceCount: 0, metricCount: 0 },
			],
		})
		expect(check(report, "ING-01").status).toBe("pass")
		const identity = check(report, "RES-01")
		expect(identity.status).toBe("fail")
		expect(identity.affected[0]?.name).toBe("(no service.name)")
	})
})

describe("LOG-01 — traced services also log", () => {
	it("stays quiet for an org that sends no logs at all", () => {
		const report = telemetry({
			serviceUsage: [{ serviceName: "api", logCount: 0, traceCount: 900, metricCount: 0 }],
			logCorrelation: [],
		})
		expect(check(report, "LOG-01").status).toBe("pass")
	})

	it("flags the inconsistent service once the org logs elsewhere", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 0 },
				{ serviceName: "worker", logCount: 0, traceCount: 200, metricCount: 0 },
			],
		})
		const result = check(report, "LOG-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("worker")
	})
})

describe("LOG-02 — logs carry trace context", () => {
	const broken = [
		{
			serviceName: "api",
			logCount: 500,
			uncorrelatedCount: 500,
			errorLogCount: 20,
			uncorrelatedErrorCount: 20,
		},
	]

	it("flags a traced service whose logs have no trace_id", () => {
		const result = check(telemetry({ logCorrelation: broken }), "LOG-02")
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("warn")
		expect(result.affected[0]?.note).toContain("100% of logs have no trace_id")
		expect(result.affected[0]?.note).toContain("20 error-level")
	})

	it("ignores a service below the volume floor, where a rate means nothing", () => {
		const report = telemetry({
			logCorrelation: [
				{
					serviceName: "api",
					logCount: 5,
					uncorrelatedCount: 5,
					errorLogCount: 0,
					uncorrelatedErrorCount: 0,
				},
			],
		})
		expect(check(report, "LOG-02").status).toBe("pass")
	})

	it("ignores an untraced service — there is no trace context to attach", () => {
		const report = telemetry({
			serviceUsage: [{ serviceName: "api", logCount: 500, traceCount: 0, metricCount: 0 }],
			logCorrelation: broken,
		})
		expect(check(report, "LOG-02").status).toBe("pass")
	})

	it("tolerates a minority of uncorrelated logs", () => {
		const report = telemetry({
			logCorrelation: [
				{
					serviceName: "api",
					logCount: 500,
					uncorrelatedCount: 100,
					errorLogCount: 0,
					uncorrelatedErrorCount: 0,
				},
			],
		})
		expect(check(report, "LOG-02").status).toBe("pass")
	})

	it("is only info when some logs are correlated, naming the line logged outside spans", () => {
		const report = telemetry({
			logCorrelation: [
				{
					serviceName: "api",
					logCount: 461,
					uncorrelatedCount: 444,
					errorLogCount: 0,
					uncorrelatedErrorCount: 0,
					topUncorrelatedMessage: "Skipping chat connector with no configuration",
				},
			],
		})
		const result = check(report, "LOG-02")
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("info")
		expect(result.affected[0]?.note).toBe(
			'96% of logs are emitted outside any span, mostly: "Skipping chat connector with no configuration"',
		)
		expect(report.summary.warn).toBe(0)
	})

	it("never quotes a secret from the sampled message", () => {
		const report = telemetry({
			logCorrelation: [
				{
					serviceName: "api",
					logCount: 461,
					uncorrelatedCount: 444,
					errorLogCount: 0,
					uncorrelatedErrorCount: 0,
					topUncorrelatedMessage: "booting with token=ghp_9f8e7d6c5b4a3210fedcba9876543210abcd",
				},
			],
		})
		const note = check(report, "LOG-02").affected[0]?.note ?? ""
		expect(note).toContain("token=[redacted]")
		expect(note).not.toContain("ghp_")
	})

	it("warns for a bridgeless service and lists the info-level one beside it", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 0 },
				{ serviceName: "bot", logCount: 461, traceCount: 100, metricCount: 0 },
			],
			logCorrelation: [
				...broken,
				{
					serviceName: "bot",
					logCount: 461,
					uncorrelatedCount: 444,
					errorLogCount: 0,
					uncorrelatedErrorCount: 0,
				},
			],
		})
		const result = check(report, "LOG-02")
		expect(result.severity).toBe("warn")
		expect(result.detail).toContain("1 service emits logs with no trace context")
		expect(Arr.map(result.affected, (entity) => entity.name)).toEqual(["api", "bot"])
	})
})

describe("LOG-03 — logs are structured", () => {
	it("stays quiet below the volume floor even with no attributes", () => {
		const report = telemetry({
			serviceUsage: [{ serviceName: "api", logCount: 100, traceCount: 900, metricCount: 0 }],
			attributeKeys: Arr.filter(healthyWarehouse.attributeKeys, (row) => row.scope !== "log"),
		})
		expect(check(report, "LOG-03").status).toBe("pass")
	})

	it("flags high log volume with no structured fields", () => {
		const report = telemetry({
			serviceUsage: [{ serviceName: "api", logCount: 50_000, traceCount: 900, metricCount: 0 }],
			attributeKeys: Arr.filter(healthyWarehouse.attributeKeys, (row) => row.scope !== "log"),
		})
		const result = check(report, "LOG-03")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("50,000 log records")
	})
})

describe("LOG-04 — standard severities", () => {
	it("accepts the standard levels and their numbered variants", () => {
		const report = telemetry({
			logSeverity: [
				{ serviceName: "api", severityText: "INFO", logCount: 10 },
				{ serviceName: "api", severityText: "warn", logCount: 10 },
				{ serviceName: "api", severityText: "DEBUG3", logCount: 10 },
				{ serviceName: "api", severityText: "WARNING", logCount: 10 },
				{ serviceName: "api", severityText: "", logCount: 10 },
			],
		})
		expect(check(report, "LOG-04").status).toBe("pass")
	})

	it("flags a non-standard level", () => {
		const report = telemetry({
			logSeverity: [{ serviceName: "api", severityText: "NOTICE", logCount: 90 }],
		})
		const result = check(report, "LOG-04")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toContain('severity "NOTICE"')
	})

	it("drops a non-standard text that always carries a valid SeverityNumber", () => {
		const correlation = Arr.getUnsafe(healthyWarehouse.logCorrelation, 0)
		const report = telemetry({
			logSeverity: [
				{ serviceName: "api", severityText: "log", logCount: 10_000 },
				{ serviceName: "api", severityText: "NOTICE", logCount: 90 },
				{ serviceName: "api", severityText: "verbose", logCount: 30 },
			],
			logCorrelation: [
				{
					...correlation,
					numberedOddSeverities: ["log", "verbose"],
					// `verbose` also arrives without a number, so the logger still needs mapping.
					unnumberedOddSeverities: ["NOTICE", "verbose"],
				},
			],
		})
		const result = check(report, "LOG-04")
		expect(Arr.map(result.affected, (entity) => entity.note)).toEqual([
			'severity "NOTICE" (90 records)',
			'severity "verbose" (30 records)',
		])
	})
})

describe("resource-attribute coverage", () => {
	const withoutResourceKey = (key: string) =>
		telemetry({ attributeKeys: Arr.filter(healthyWarehouse.attributeKeys, (row) => row.key !== key) })

	it("RES-02 flags a missing service.version", () => {
		expect(check(withoutResourceKey("service.version"), "RES-02").status).toBe("fail")
	})

	it("RES-04 flags a missing repository URL", () => {
		expect(check(withoutResourceKey("vcs.repository.url.full"), "RES-04").status).toBe("fail")
	})

	it("RES-05 requires the semconv revision key — the retired deployment.commit_sha no longer counts", () => {
		const legacy = telemetry({
			attributeKeys: [
				...Arr.filter(healthyWarehouse.attributeKeys, (row) => row.key !== "vcs.ref.head.revision"),
				resourceKey("deployment.commit_sha"),
			],
		})
		expect(check(legacy, "RES-05").status).toBe("fail")
		expect(check(withoutResourceKey("vcs.ref.head.revision"), "RES-05").status).toBe("fail")
	})

	it("names each service missing a key, even when another service sets it; clients owe only a version", () => {
		const report = telemetry({
			services: [
				{
					serviceName: "api",
					namespaces: [],
					environments: ["production"],
					sdkLanguages: ["nodejs"],
				},
				{
					serviceName: "landing",
					namespaces: [],
					environments: ["production"],
					sdkLanguages: ["webjs"],
				},
				{ serviceName: "ios", namespaces: [], environments: ["production"], sdkLanguages: ["swift"] },
				{ serviceName: "pr-app", namespaces: [], environments: ["pr-12"], sdkLanguages: ["nodejs"] },
			],
			serviceResourceKeys: [
				{
					serviceName: "api",
					keys: ["service.version", "vcs.repository.url.full", "vcs.ref.head.revision"],
				},
				{ serviceName: "landing", keys: [] },
				{ serviceName: "ios", keys: ["service.version"] },
				// Maple's own and preview-only services are not the user's to fix here.
				{ serviceName: "maple-uptime", keys: [] },
				{ serviceName: "pr-app", keys: [] },
				{ serviceName: "worker", keys: ["service.version"] },
			],
		})
		const names = (id: string) => Arr.map(check(report, id).affected, (entity) => entity.name)
		expect(names("RES-02")).toEqual(["landing"])
		// Source links and revisions anchor server deploys; a browser or app build is judged on its version.
		expect(names("RES-04")).toEqual(["worker"])
		expect(names("RES-05")).toEqual(["worker"])
		expect(check(report, "RES-04").detail).toContain("1 service sets no `vcs.repository.url.full`")
	})

	it("passes per service when every service sets the key", () => {
		const report = telemetry({
			serviceResourceKeys: [{ serviceName: "api", keys: ["service.version"] }],
		})
		expect(check(report, "RES-02").status).toBe("pass")
		expect(check(report, "RES-04").status).toBe("fail")
	})

	it("falls back to the org-wide key check when the per-service read returns no rows", () => {
		expect(check(telemetry({ serviceResourceKeys: [] }), "RES-02").status).toBe("pass")
		const missing = telemetry({
			serviceResourceKeys: [],
			attributeKeys: Arr.filter(healthyWarehouse.attributeKeys, (row) => row.key !== "service.version"),
		})
		expect(check(missing, "RES-02").status).toBe("fail")
	})

	it("RES-06 flags invented parallel keys, including the retired deployment.commit_sha", () => {
		const invented = telemetry({
			attributeKeys: [
				...healthyWarehouse.attributeKeys,
				resourceKey("env"),
				resourceKey("git.repo"),
				resourceKey("deployment.commit_sha"),
			],
		})
		const result = check(invented, "RES-06")
		expect(result.status).toBe("fail")
		expect(Arr.map(result.affected, (entity) => entity.name).sort()).toEqual([
			"deployment.commit_sha",
			"env",
			"git.repo",
		])
	})

	it("RES-06 names the emitter and judges the advice by the value the key holds", () => {
		const report = telemetry({
			attributeKeys: [
				...healthyWarehouse.attributeKeys,
				resourceKey("deployment.commit_sha"),
				resourceKey("git.sha"),
			],
			resourceKeySamples: [
				{ key: "deployment.commit_sha", value: "0.1.0+685", usageCount: 45 },
				{ key: "deployment.commit_sha", value: "0.1.0+684", usageCount: 12 },
				{ key: "git.sha", value: "1c65f321af", usageCount: 30 },
			],
			resourceKeyServices: [{ key: "deployment.commit_sha", serviceName: "ios" }],
		})
		const notes = Rec.fromEntries(
			Arr.map(check(report, "RES-06").affected, (entity) => [entity.name, entity.note ?? ""] as const),
		)
		expect(notes["deployment.commit_sha"]).toBe(
			'from ios; e.g. "0.1.0+685"; holds a version, so send it as `service.version`',
		)
		expect(notes["git.sha"]).toBe('e.g. "1c65f321af"; rename to `vcs.ref.head.revision`')
	})

	it("RES-06 says remove the key when the service already sends its semconv twin with the same value", () => {
		const report = telemetry({
			attributeKeys: [...healthyWarehouse.attributeKeys, resourceKey("deployment.commit_sha")],
			resourceKeySamples: [{ key: "deployment.commit_sha", value: "0.1.0+1100", usageCount: 45 }],
			resourceKeyServices: [
				{ key: "deployment.commit_sha", serviceName: "ios", duplicateOf: "service.version" },
			],
		})
		const result = check(report, "RES-06")
		expect(result.affected[0]?.note).toBe(
			'same value as its `service.version`, so remove this key; from ios; e.g. "0.1.0+1100"',
		)
		// Pure duplication loses nothing, so it is advisory and says so.
		expect(result.severity).toBe("info")
		expect(result.detail).toBe(
			"`deployment.commit_sha` already arrives as `service.version` with the same value; the extra key only adds noise.",
		)
	})
})

describe("RES-03 — spans carry an environment", () => {
	const profile = (noEnvCount: number) => [{ ...healthyServiceSpans, noEnvCount }]

	it("flags a service where most spans have no environment", () => {
		const result = check(telemetry({ spanShape: profile(900) }), "RES-03")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("100% of spans have no environment")
	})

	it("tolerates a minority of unlabeled spans", () => {
		expect(check(telemetry({ spanShape: profile(100) }), "RES-03").status).toBe("pass")
	})
})

describe("NAME-02 — span-name cardinality", () => {
	const templates = (row: Partial<NonNullable<WarehouseAuditInputs["spanNameTemplates"]>[number]>) =>
		telemetry({
			spanNameTemplates: [
				{
					serviceName: "api",
					rawNameCount: 545,
					templateCount: 542,
					topTemplateNameCount: 2,
					exampleNames: ["a"],
					...row,
				},
			],
		})

	it("passes a large set of real operation names", () => {
		expect(check(templates({}), "NAME-02").status).toBe("pass")
	})

	it("flags names that collapse onto far fewer templates, with examples", () => {
		const result = check(
			templates({
				rawNameCount: 4_000,
				templateCount: 30,
				topTemplateNameCount: 3_900,
				exampleNames: ["GET /orders/1", "GET /orders/2"],
			}),
			"NAME-02",
		)
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe(
			'4,000 distinct span names but only 30 once IDs are removed; e.g. "GET /orders/1", "GET /orders/2"',
		)
	})

	it("flags an extreme number of distinct operations even without IDs", () => {
		const result = check(templates({ rawNameCount: 2_500, templateCount: 2_400 }), "NAME-02")
		expect(result.affected[0]?.note).toBe("2,400 distinct span names even with IDs removed")
	})

	it("falls back to the raw count, at the extreme limit, when the template read failed", () => {
		expect(
			check(telemetry({ spanShape: [{ ...healthyServiceSpans, spanNameCount: 545 }] }), "NAME-02")
				.status,
		).toBe("pass")
		const result = check(
			telemetry({ spanShape: [{ ...healthyServiceSpans, spanNameCount: 40_000 }] }),
			"NAME-02",
		)
		expect(result.affected[0]?.note).toBe("40,000 distinct span names")
	})
})

describe("NAME-03 — reserved namespace", () => {
	it("flags customer attributes in the maple_ namespace", () => {
		const report = telemetry({
			attributeKeys: [...healthyWarehouse.attributeKeys, spanKey("maple_tenant")],
		})
		const result = check(report, "NAME-03")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("maple_tenant")
	})

	it("does not flag ordinary namespaced keys", () => {
		const report = telemetry({
			attributeKeys: [...healthyWarehouse.attributeKeys, spanKey("maplesyrup.batch")],
		})
		expect(check(report, "NAME-03").status).toBe("pass")
	})

	it("does not flag the maple_ai.* keys Maple's ingest stamps on agent spans", () => {
		const report = telemetry({
			attributeKeys: [
				...healthyWarehouse.attributeKeys,
				spanKey("maple_ai.session.id"),
				spanKey("maple_ai.usage.input_tokens"),
			],
		})
		expect(check(report, "NAME-03").status).toBe("pass")
	})
})

describe("PII-01 — secrets in attribute names", () => {
	it("names the service and span that emit a flagged key", () => {
		const key = "http.request.header.x-maple-maintenance-token"
		const report = telemetry({
			attributeKeys: [...healthyWarehouse.attributeKeys, spanKey(key)],
			sensitiveKeyEmitters: [{ key, serviceName: "cli", spanName: "http.client POST" }],
		})
		expect(check(report, "PII-01").affected[0]?.note).toBe('span; sent by cli on "http.client POST"')
	})

	it.each([
		"user.password",
		"http.request.header.authorization",
		"api_key",
		"auth.accessToken",
		"payment.credit_card",
		"http.request.header.x-maple-maintenance-token",
		"cookie",
		"session.cookie",
		"http.request.header.cookie",
		"oauth.client_secret",
		"credit.card.number",
		"creditcard_number",
		"db.password.hash",
		"user.ssn_last4",
	])("flags %s", (key) => {
		const report = telemetry({ attributeKeys: [...healthyWarehouse.attributeKeys, spanKey(key)] })
		expect(check(report, "PII-01").status).toBe("fail")
	})

	it.each([
		"gen_ai.usage.output_tokens",
		"gen_ai.usage.input_tokens",
		"db.query.text",
		"http.route",
		"user.id",
		// Keys that describe a credential rather than hold one.
		"maple.api_key.id",
		"cookie_consent",
		"has_cookie",
		"maple.api_key.kind",
		"maple.api_key.last_used_memo_hit",
		"maple.app.auth.has_token",
		"maple.device.credential_id",
		"maple.tinybird.token.scope",
		"vcs.provider.token_cache",
		"maple.app.widget.fetch.credential_rejected",
		"user.password_changed",
		"auth.password.policy",
		"maple.app.auth.has_password",
	])("does not flag %s", (key) => {
		const report = telemetry({ attributeKeys: [...healthyWarehouse.attributeKeys, spanKey(key)] })
		expect(check(report, "PII-01").status).toBe("pass")
	})
})

describe("MET-01 — metric label cardinality", () => {
	it("flags an unbounded label", () => {
		const report = telemetry({
			metricLabels: [
				{ attributeKey: "http.route", valueCardinality: 40 },
				{ attributeKey: "user.id", valueCardinality: 90_000 },
			],
		})
		const result = check(report, "MET-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("user.id")
		expect(result.detail).toContain("Counter metrics only")
	})

	it("judges each metric on its own once the per-metric read ran", () => {
		const flagged = [{ attributeKey: "url.path", valueCardinality: 3_383 }]
		const series = (cardinalities: ReadonlyArray<readonly [string, number]>, serviceName = "api") =>
			telemetry({
				metricLabels: flagged,
				metricLabelsMeasured: cardinalities.length > 0 ? ["url.path"] : [],
				metricLabelSeries: Arr.map(cardinalities, ([metricName, valueCardinality]) => ({
					attributeKey: "url.path",
					serviceName,
					metricName,
					valueCardinality,
				})),
			})
		// The union across metrics is high, but no single metric is.
		expect(
			check(
				series([
					["http.requests", 600],
					["http.bytes", 600],
				]),
				"MET-01",
			).status,
		).toBe("pass")
		// Only Maple's folded integration rows carry the label: not the user's to fix.
		expect(
			check(series([["cloudflare.http.requests.by_path", 3_600]], "cloudflare/"), "MET-01").status,
		).toBe("pass")
		// No row at all (outside the read's window): the rollup's count stands, marked unconfirmed.
		expect(check(series([]), "MET-01").affected[0]?.note).toBe(
			"~3,383 distinct values across all metrics (org-wide, not confirmed per metric)",
		)

		const result = check(
			series([
				["http.requests", 2_400],
				["http.bytes", 1_100],
				["other", 10],
			]),
			"MET-01",
		)
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe(
			"~2,400 values on `http.requests` (api), ~1,100 values on `http.bytes` (api)",
		)
	})

	it("keeps reporting flagged labels past the per-metric read's key cap from the rollup", () => {
		const labels = Arr.makeBy(11, (index) => ({
			attributeKey: `label.${index + 1}`,
			valueCardinality: 5_000,
		}))
		const report = telemetry({
			metricLabels: labels,
			// The read covers the first ten keys and finds each one low per metric.
			metricLabelsMeasured: Arr.map(Arr.take(labels, 10), (label) => label.attributeKey),
			metricLabelSeries: Arr.map(Arr.take(labels, 10), (label) => ({
				attributeKey: label.attributeKey,
				serviceName: "api",
				metricName: "http.requests",
				valueCardinality: 20,
			})),
		})
		expect(Arr.map(check(report, "MET-01").affected, (entity) => entity.name)).toEqual(["label.11"])
	})
})

describe("STAT-01 — status and kind casing", () => {
	it("names the offending literals", () => {
		const report = telemetry({
			spanShape: [
				{
					...healthyServiceSpans,
					badStatusCodes: ["ERROR"],
					badSpanKinds: ["SPAN_KIND_SERVER"],
				},
			],
		})
		const result = check(report, "STAT-01")
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("critical")
		expect(result.affected[0]?.note).toBe('status "ERROR", kind "SPAN_KIND_SERVER"')
	})
})

describe("STAT-02 — failures recorded on spans", () => {
	it("flags a service that logs errors but never marks a span failed", () => {
		const report = telemetry({
			spanShape: [{ ...healthyServiceSpans, errorCount: 0 }],
			logSeverity: [{ serviceName: "api", severityText: "ERROR", logCount: 12 }],
		})
		const result = check(report, "STAT-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("12 error logs, no error spans")
	})

	it("passes when the service does mark spans failed", () => {
		const report = telemetry({
			logSeverity: [{ serviceName: "api", severityText: "ERROR", logCount: 12 }],
		})
		expect(check(report, "STAT-02").status).toBe("pass")
	})

	it("passes when the service logs no errors either", () => {
		const report = telemetry({ spanShape: [{ ...healthyServiceSpans, errorCount: 0 }] })
		expect(check(report, "STAT-02").status).toBe("pass")
	})
})

describe("STAT-04 — entry-point spans", () => {
	it("reports a service with no Server or Consumer spans, as advisory only", () => {
		const report = telemetry({
			spanShape: [{ ...healthyServiceSpans, serverCount: 0, consumerCount: 0 }],
		})
		const result = check(report, "STAT-04")
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("info")
	})

	it("accepts a queue consumer as an entry point", () => {
		const report = telemetry({
			spanShape: [{ ...healthyServiceSpans, serverCount: 0, consumerCount: 30 }],
		})
		expect(check(report, "STAT-04").status).toBe("pass")
	})
})

describe("MAP-02 — database identity", () => {
	const edges = (
		...rows: ReadonlyArray<readonly [service: string, system: string, namespace: string, calls: number]>
	) =>
		telemetry({
			dbEdges: Arr.map(rows, ([serviceName, dbSystem, dbNamespace, callCount]) => ({
				serviceName,
				dbSystem,
				dbNamespace,
				callCount,
			})),
		})

	it("flags a dependency whose calls carry no namespace", () => {
		const result = check(edges(["api", "postgresql", "", 100]), "MAP-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("api")
		expect(result.affected[0]?.note).toBe("postgresql calls carry no `db.namespace`")
		expect(result.detail).toContain("1 database dependency arrives with no database name")
	})

	it("says a database is split across nodes when some calls do name it", () => {
		const result = check(
			edges(["cli", "clickhouse", "", 446], ["cli", "clickhouse", "default", 28]),
			"MAP-02",
		)
		expect(result.affected[0]?.note).toBe(
			"clickhouse split across nodes: 446 calls unnamed; 28 as `default`",
		)
		expect(result.detail).toContain("1 database dependency is split between a named and an unnamed node")
	})

	it("groups Hyperdrive services under one cause and names it in the headline and fix", () => {
		const result = check(
			edges(
				["api", "postgresql", "hyperdrive", 500],
				["worker", "postgresql", "hyperdrive", 900],
				["cron", "mysql", "db.internal.example.com", 40],
				["ingest", "postgresql", "postgres", 300],
			),
			"MAP-02",
		)
		expect(Arr.map(result.affected, (entity) => [entity.name, entity.note])).toEqual([
			["worker", "postgresql: namespace is an opaque Hyperdrive id"],
			["cron", "mysql node named after the host `db.internal.example.com`"],
			["api", "postgresql: namespace is an opaque Hyperdrive id"],
		])
		expect(result.detail).toMatch(
			/^3 database dependencies lack a usable name \(2 behind Cloudflare Hyperdrive, 1 with no name\)\. 2 services connect through Cloudflare Hyperdrive/,
		)
		expect(result.detail).toContain("1 database dependency arrives with no database name")
		expect(result.fixHint).toContain("Through Hyperdrive")
	})

	it("leads with both causes and keeps a split service in view beside many Hyperdrive ones", () => {
		const result = check(
			edges(
				["a", "postgresql", "hyperdrive", 900],
				["b", "postgresql", "hyperdrive", 800],
				["c", "postgresql", "hyperdrive", 700],
				["d", "postgresql", "hyperdrive", 600],
				["cli", "clickhouse", "", 446],
				["cli", "clickhouse", "default", 28],
			),
			"MAP-02",
		)
		expect(result.detail).toMatch(
			/^5 database dependencies lack a usable name \(4 behind Cloudflare Hyperdrive, 1 split across nodes\)\./,
		)
		expect(Arr.map(Arr.take(result.affected, 2), (entity) => entity.name)).toEqual(["a", "cli"])
		expect(result.affectedCount).toBe(5)
	})

	it("accepts an HTTP-API warehouse named after its regional host", () => {
		const result = check(
			edges(
				["api", "tinybird", "api.us-east.aws.tinybird.co", 300],
				["api", "tinybird", "api.eu-central-1.aws.tinybird.co", 30],
			),
			"MAP-02",
		)
		expect(result.status).toBe("pass")
	})

	it("accepts a mostly named dependency and dotted database names", () => {
		expect(
			check(edges(["api", "postgresql", "orders", 90], ["api", "postgresql", "", 10]), "MAP-02").status,
		).toBe("pass")
		expect(check(edges(["api", "postgresql", "orders.public", 90]), "MAP-02").status).toBe("pass")
	})
})

describe("trace completeness", () => {
	const traces = (overrides: Partial<NonNullable<WarehouseAuditInputs["traceCompleteness"]>>) =>
		telemetry({ traceCompleteness: { ...healthyWarehouse.traceCompleteness!, ...overrides } })

	it("skips all three checks when the joins did not run", () => {
		const report = telemetry({ traceCompleteness: undefined })
		for (const id of ["TRC-01", "TRC-02", "TRC-03", "TRC-04"]) {
			// The joins degrade independently of the rest of the telemetry reads, so the checks pass
			// rather than skip — the report never claims a gap it did not measure.
			expect(check(report, id).status).toBe("pass")
		}
	})

	describe("TRC-01 — orphan spans", () => {
		it("flags a service whose entry spans reference a missing parent", () => {
			const report = traces({
				orphans: [
					{
						serviceName: "checkout",
						childCount: 800,
						orphanCount: 400,
						sampledOrphanCount: 0,
						externalParentCount: 0,
						sampleTraceIds: ["abc123"],
					},
				],
			})
			const result = check(report, "TRC-01")
			expect(result.status).toBe("fail")
			expect(result.affected[0]?.note).toContain("50% of entry spans")
			expect(result.affected[0]?.note).toContain("trace abc123")
		})

		it("attributes sampling-marked orphans to TRC-03 instead", () => {
			const report = traces({
				orphans: [
					{
						serviceName: "checkout",
						childCount: 800,
						orphanCount: 400,
						sampledOrphanCount: 400,
						externalParentCount: 0,
						sampleTraceIds: [],
					},
				],
			})
			expect(check(report, "TRC-01").status).toBe("pass")
			const sampling = check(report, "TRC-03")
			expect(sampling.status).toBe("fail")
			expect(sampling.severity).toBe("info")
			expect(sampling.affected[0]?.note).toContain("100% of its incomplete traces")
		})

		it("ignores a service with too few observed spans for a rate to mean anything", () => {
			const report = traces({
				orphans: [
					{
						serviceName: "cron",
						childCount: 10,
						orphanCount: 10,
						sampledOrphanCount: 0,
						externalParentCount: 0,
						sampleTraceIds: [],
					},
				],
			})
			expect(check(report, "TRC-01").status).toBe("pass")
			expect(check(report, "TRC-03").status).toBe("pass")
		})
	})

	describe("TRC-04 — inbound requests continuing an outside trace", () => {
		// maple-api in prod: every orphan and rootless trace came from an external MCP client.
		const external = traces({
			orphans: [
				{
					serviceName: "api",
					childCount: 1_500,
					orphanCount: 140,
					sampledOrphanCount: 0,
					externalParentCount: 140,
					sampleTraceIds: [],
				},
			],
			rootless: withOrgTotals([
				{
					entryService: "api",
					traceCount: 7_400,
					rootlessCount: 44,
					sampledRootlessCount: 0,
					externalParentCount: 44,
				},
				{ entryService: "cli", traceCount: 22_000, rootlessCount: 0, sampledRootlessCount: 0 },
			]),
			inboundRoutes: [
				{ serviceName: "api", route: "/mcp", traceCount: 9 },
				{ serviceName: "api", route: "/oauth/token", traceCount: 1 },
			],
		})

		it("keeps them out of TRC-01 and TRC-02", () => {
			expect(check(external, "TRC-01").status).toBe("pass")
			expect(check(external, "TRC-02").status).toBe("pass")
		})

		it("reports them as info, naming the routes they arrive on", () => {
			const result = check(external, "TRC-04")
			expect(result.status).toBe("fail")
			expect(result.severity).toBe("info")
			expect(result.affected).toEqual([
				{
					kind: "service",
					name: "api",
					note: "44 traces started by an outside caller, mostly via `/mcp`, `/oauth/token`; your instrumented services call it too, so the missing caller may be one of yours",
				},
			])
			expect(result.detail).toContain("an upstream service of yours that is not exporting spans")
		})

		it("never quotes a query string, and omits the in-org hint when no instrumented service calls it", () => {
			const report = traces({
				rootless: withOrgTotals([
					{
						entryService: "auth",
						traceCount: 100,
						rootlessCount: 5,
						sampledRootlessCount: 0,
						externalParentCount: 5,
					},
				]),
				inboundRoutes: [{ serviceName: "auth", route: "/cb?code=s3cr3t&state=xyz", traceCount: 5 }],
			})
			expect(check(report, "TRC-04").affected[0]?.note).toBe(
				"5 traces started by an outside caller, mostly via `/cb`",
			)
		})

		it("still reports the orphans that are not external under TRC-01", () => {
			const report = traces({
				orphans: [
					{
						serviceName: "api",
						childCount: 1_000,
						orphanCount: 400,
						sampledOrphanCount: 0,
						externalParentCount: 100,
						sampleTraceIds: ["abc"],
					},
				],
			})
			expect(check(report, "TRC-01").affected[0]?.note).toContain("30% of entry spans")
		})

		it("passes when nothing arrives from outside", () => {
			expect(check(traces({}), "TRC-04").status).toBe("pass")
		})

		it("names only services with at least three such traces and counts the rest", () => {
			const row = (entryService: string, externalParentCount: number) => ({
				entryService,
				traceCount: 1_000,
				rootlessCount: externalParentCount,
				sampledRootlessCount: 0,
				externalParentCount,
			})
			// One rootless trace stays one, however many of its spans continue the caller.
			const sparse = traces({
				rootless: withOrgTotals([row("web", 1), row("alerting", 1)]),
				orphans: [
					{
						serviceName: "web",
						childCount: 19,
						orphanCount: 9,
						sampledOrphanCount: 0,
						externalParentCount: 9,
						sampleTraceIds: [],
					},
				],
			})
			expect(check(sparse, "TRC-04").status).toBe("pass")
			const result = check(
				traces({ rootless: withOrgTotals([row("api", 69), row("web", 1), row("alerting", 1)]) }),
				"TRC-04",
			)
			expect(Arr.map(result.affected, (entity) => entity.name)).toEqual(["api"])
			expect(result.detail).toContain("2 other services see fewer than 3 such traces each.")
		})
	})

	describe("TRC-02 — rootless traces", () => {
		const rootless = (
			...rows: ReadonlyArray<
				readonly [service: string, traces: number, rootless: number, sampled?: number]
			>
		) =>
			traces({
				rootless: withOrgTotals(
					Arr.map(rows, ([entryService, traceCount, rootlessCount, sampledRootlessCount = 0]) => ({
						entryService,
						traceCount,
						rootlessCount,
						sampledRootlessCount,
					})),
				),
			})

		it("names a service only on three or more sampled rootless traces", () => {
			const result = check(rootless(["api", 9_000, 30], ["web", 7, 1]), "TRC-02")
			expect(Arr.map(result.affected, (entity) => entity.name)).toEqual(["api"])
			expect(result.detail).toContain("1 other service loses a root on too few sampled traces to name.")
		})

		it("passes with a single trace that lacks a root", () => {
			expect(check(rootless(["api", 9_000, 1]), "TRC-02").status).toBe("pass")
		})

		it("is info for two or more rootless traces at or below 0.1%", () => {
			const report = rootless(["api", 9_000, 10], ["web", 1_000, 0])
			const result = check(report, "TRC-02")
			expect(result.status).toBe("fail")
			expect(result.severity).toBe("info")
			expect(result.detail).toContain("0.1% of traces have no root span: 10 of 10000 traces")
			expect(report.summary.info).toBe(1)
		})

		it("warns above 0.1% of traces, measured across the whole org", () => {
			// 0.5% of api's own traces, but 0.25% of the org's: the org-wide rate picks the tier.
			const report = rootless(["api", 4_000, 20], ["web", 4_000, 0])
			const result = check(report, "TRC-02")
			expect(result.status).toBe("fail")
			expect(result.severity).toBe("warn")
			expect(result.detail).toContain("0.25% of traces have no root span: 20 of 8000 traces")
			expect(Arr.map(result.affected, (entity) => entity.name)).toEqual(["api"])
			expect(result.affected[0]?.note).toBe("0.5% of traces starting here have no root (20 of 4000)")
			expect(report.summary.warn).toBe(1)
		})

		it("stays at warn above 1% of traces", () => {
			const report = rootless(["worker", 500, 500], ["api", 5_000, 30], ["cli", 40_000, 3])
			const result = check(report, "TRC-02")
			expect(result.severity).toBe("warn")
			expect(result.detail).toContain("1.2% of traces")
			expect(Arr.map(result.affected, (entity) => entity.name)).toEqual(["worker", "api", "cli"])
			expect(report.summary.critical).toBe(0)
			expect(report.summary.warn).toBe(1)
		})

		it("keeps its base severity while passing", () => {
			expect(check(rootless(["api", 1_000, 0]), "TRC-02").severity).toBe("warn")
		})

		it("does not fail or name a service on fewer than 50 sampled traces", () => {
			// A thin sample (3 of 15) flips between runs, so it is no evidence on its own.
			const result = check(rootless(["ingest", 2_000, 0], ["electric-sync", 15, 3]), "TRC-02")
			expect(result.status).toBe("pass")
		})

		it("still counts an under-sampled service toward the org-wide rate", () => {
			const result = check(rootless(["api", 9_000, 4], ["web", 30, 5]), "TRC-02")
			expect(result.status).toBe("fail")
			expect(result.detail).toContain("9 of 9030 traces")
			expect(Arr.map(result.affected, (entity) => entity.name)).toEqual(["api"])
			expect(result.detail).toContain("1 other service loses a root on too few sampled traces to name.")
		})

		it("does not blame upstream when the row cap cut services it cannot see", () => {
			const api = {
				entryService: "api",
				traceCount: 9_800,
				rootlessCount: 9_800,
				sampledRootlessCount: 0,
				orgTraceCount: 10_000,
				orgRootlessCount: 9_800,
				orgSampledRootlessCount: 0,
				externalParentCount: 0,
				orgExternalParentCount: 0,
			}
			const result = check(traces({ rootless: [api] }), "TRC-02")
			expect(result.detail).toContain("98% of traces have no root span: 9800 of 10000 traces")
		})

		it("rates the whole org, including services past the row cap", () => {
			// The query returned only api; the org totals also count 90,000 healthy traces it cut.
			const api = {
				entryService: "api",
				traceCount: 10_000,
				rootlessCount: 200,
				sampledRootlessCount: 0,
				orgTraceCount: 100_000,
				orgRootlessCount: 200,
				orgSampledRootlessCount: 0,
				externalParentCount: 0,
				orgExternalParentCount: 0,
			}
			const report = traces({ rootless: [api] })
			const result = check(report, "TRC-02")
			expect(result.severity).toBe("warn")
			expect(result.detail).toContain("0.2% of traces have no root span: 200 of 100000 traces")
		})

		it("does not count traces whose root the sampler dropped", () => {
			expect(check(rootless(["api", 1_000, 50, 50]), "TRC-02").status).toBe("pass")
		})

		it("scales sampled counts and says they come from a trace sample", () => {
			const report = traces({
				traceSampleModulus: 4,
				rootless: withOrgTotals([
					{ entryService: "api", traceCount: 1_000, rootlessCount: 5, sampledRootlessCount: 0 },
				]),
			})
			const result = check(report, "TRC-02")
			// Leads with the rate; counts are scaled up and labelled as an estimate, never exact.
			expect(result.detail).toContain(
				"0.5% of traces have no root span: about 20 traces an hour, estimated from a 1-in-4 trace sample",
			)
			expect(result.affected[0]?.note).toContain("(5 of 1000 in a 1-in-4 sample)")
		})

		it("warns, not escalates, at exactly 1% of traces", () => {
			expect(check(rootless(["api", 1_000, 10]), "TRC-02").severity).toBe("warn")
		})

		it("blames upstream when every service's traces arrive without a root", () => {
			const result = check(rootless(["api", 800, 800], ["checkout", 800, 796]), "TRC-02")
			expect(result.severity).toBe("warn")
			expect(result.detail).toContain("created upstream of your instrumented services")
			expect(Arr.map(result.affected, (entity) => entity.name)).toEqual(["api", "checkout"])
		})

		it("names the service when one dominant service is the whole problem", () => {
			const result = check(rootless(["gateway-fronted", 9_700, 9_700], ["billing", 300, 0]), "TRC-02")
			expect(result.detail).toContain("97% of traces have no root span")
			expect(Arr.map(result.affected, (entity) => entity.name)).toEqual(["gateway-fronted"])
		})
	})
})

describe("services Maple writes itself", () => {
	const identity = (
		serviceName: string,
		over: Partial<WarehouseAuditInputs["services"][number]> = {},
	): WarehouseAuditInputs["services"][number] => ({
		serviceName,
		namespaces: [],
		environments: [],
		sdkLanguages: [],
		...over,
	})
	const noEntrySpans = (serviceName: string) => ({
		...healthyServiceSpans,
		serviceName,
		serverCount: 0,
		consumerCount: 0,
		noEnvCount: 900,
		spanNameCount: 9_000,
	})

	it("never blames the user for uptime checks, CI traces or pulled integration data", () => {
		const report = telemetry({
			services: [
				...healthyWarehouse.services,
				identity("maple-uptime", { namespaces: ["maple-services"] }),
				identity("github-actions"),
				identity("synthetic-probe", { namespaces: ["maple-services"] }),
			],
			serviceUsage: [
				...healthyWarehouse.serviceUsage,
				{ serviceName: "maple-uptime", logCount: 0, traceCount: 1_500, metricCount: 0 },
				{ serviceName: "github-actions", logCount: 0, traceCount: 600, metricCount: 0 },
			],
			spanShape: [
				healthyServiceSpans,
				noEntrySpans("maple-uptime"),
				noEntrySpans("github-actions"),
				noEntrySpans("synthetic-probe"),
			],
			logSeverity: [
				...healthyWarehouse.logSeverity,
				{ serviceName: "cloudflare-worker/api", severityText: "log", logCount: 50 },
			],
		})
		for (const id of ["LOG-01", "RES-03", "NAME-02", "STAT-04", "LOG-04"]) {
			expect(check(report, id).status).toBe("pass")
		}
	})

	it("still reports the same telemetry from a service the user runs", () => {
		const report = telemetry({ spanShape: [healthyServiceSpans, noEntrySpans("worker")] })
		for (const id of ["RES-03", "NAME-02", "STAT-04"]) {
			expect(Arr.map(check(report, id).affected, (entity) => entity.name)).toEqual(["worker"])
		}
	})

	it("drops Maple's services from the per-metric series", () => {
		const exploded = [{ attributeKey: "url.path", valueCardinality: 3_500 }]
		const series = (serviceName: string) => ({
			attributeKey: "url.path",
			serviceName,
			metricName: "cloudflare.http.requests.by_path",
			valueCardinality: 1_500,
		})
		const integrationOnly = telemetry({
			metricLabels: exploded,
			metricLabelsMeasured: ["url.path"],
			metricLabelSeries: [series("cloudflare/example.com"), series("cloudflare/example.org")],
		})
		expect(check(integrationOnly, "MET-01").status).toBe("pass")
		expect(
			check(
				telemetry({
					metricLabels: exploded,
					metricLabelsMeasured: ["url.path"],
					metricLabelSeries: [series("api")],
				}),
				"MET-01",
			).status,
		).toBe("fail")
		// No per-metric read (it failed) keeps the rollup's finding.
		expect(check(telemetry({ metricLabels: exploded }), "MET-01").status).toBe("fail")
	})

	it("rates rootless traces without Maple's services in the org totals", () => {
		const report = telemetry({
			traceCompleteness: {
				...healthyWarehouse.traceCompleteness!,
				rootless: withOrgTotals([
					{ entryService: "api", traceCount: 1_000, rootlessCount: 1, sampledRootlessCount: 0 },
					{
						entryService: "maple-uptime",
						traceCount: 1_000,
						rootlessCount: 900,
						sampledRootlessCount: 0,
					},
				]),
			},
		})
		expect(check(report, "TRC-02").status).toBe("pass")
	})

	it("classifies by namespace, name, integration prefix, SDK language and environment", () => {
		expect(classifyService("maple-uptime", undefined)).toBe("maple")
		expect(classifyService("probe", identity("probe", { namespaces: ["maple-services"] }))).toBe("maple")
		expect(classifyService("cloudflare-queue/abc", undefined)).toBe("maple")
		expect(classifyService("web", identity("web", { sdkLanguages: ["webjs"] }))).toBe("client")
		expect(classifyService("ios", identity("ios", { sdkLanguages: ["swift"] }))).toBe("client")
		expect(classifyService("cli", identity("cli", { environments: ["cli"] }))).toBe("client")
		expect(classifyService("status", identity("status", { environments: ["pr-2404", "pr-2419"] }))).toBe(
			"preview",
		)
		expect(
			classifyService(
				"api",
				identity("api", { environments: ["production", "pr-2419"], sdkLanguages: ["nodejs"] }),
			),
		).toBe("app")
		expect(classifyService("node-cadvisor", undefined)).toBe("app")
	})
})

describe("client and preview services", () => {
	const clients: WarehouseAuditInputs["services"] = [
		...healthyWarehouse.services,
		{ serviceName: "web", namespaces: [], environments: ["production"], sdkLanguages: ["webjs"] },
		{ serviceName: "ios", namespaces: [], environments: ["production"], sdkLanguages: ["swift"] },
		{ serviceName: "cli", namespaces: [], environments: ["cli"], sdkLanguages: ["nodejs"] },
		{ serviceName: "status", namespaces: [], environments: ["pr-2404"], sdkLanguages: [] },
	]

	it("does not expect logs from browsers, mobile apps, CLIs or preview-only services", () => {
		const report = telemetry({
			services: clients,
			serviceUsage: [
				...healthyWarehouse.serviceUsage,
				...Arr.map(["web", "ios", "cli", "status"], (serviceName) => ({
					serviceName,
					logCount: 0,
					traceCount: 300,
					metricCount: 0,
				})),
			],
		})
		expect(check(report, "LOG-01").status).toBe("pass")
	})

	it("does not expect entry-point spans from client apps, but names a server's root span", () => {
		const report = telemetry({
			services: clients,
			spanShape: [
				...Arr.map(["web", "ios", "cli"], (serviceName) => ({
					...healthyServiceSpans,
					serviceName,
					serverCount: 0,
					consumerCount: 0,
				})),
				{
					...healthyServiceSpans,
					serviceName: "cancellation-reviews",
					serverCount: 0,
					consumerCount: 0,
					rootSpanName: "CancellationReviewQueue.processMessage",
					rootSpanKind: "Internal",
				},
			],
		})
		const result = check(report, "STAT-04")
		expect(result.affected).toEqual([
			{
				kind: "service",
				name: "cancellation-reviews",
				note: 'traces start at "CancellationReviewQueue.processMessage" (Internal), not a Server or Consumer span',
			},
		])
	})
})

describe("quoteSafely", () => {
	it("masks credentials and opaque tokens but keeps ordinary words", () => {
		expect(quoteSafely("login failed password=hunter2 for user")).toBe(
			"login failed password=[redacted] for user",
		)
		expect(quoteSafely("Authorization: Bearer abc.def")).toContain("[redacted]")
		expect(quoteSafely("connecting to postgres://admin:s3cret@db:5432")).toBe(
			"connecting to postgres://[redacted]@db:5432",
		)
		expect(quoteSafely("key sk_live_51HxQ2abcdEFGH12345678 loaded")).toBe("key [redacted] loaded")
		expect(quoteSafely("CancellationReviewQueue.processMessage started")).toBe(
			"CancellationReviewQueue.processMessage started",
		)
	})

	it.each([
		["refresh_token=abc123def", "refresh_token=[redacted]"],
		["auth_token=zz9 ok", "auth_token=[redacted] ok"],
		["client_secret: hunter2x", "client_secret: [redacted]"],
		["GET /cb?access_token=ab12cd&x=1", "GET /cb?access_token=[redacted]&x=1"],
		["Authorization: Basic dXNlcjpw", "Authorization: [redacted]"],
		["proxy-authorization=Bearer abc", "proxy-authorization=[redacted]"],
		['{"password":"hunter2"}', '{"password":"[redacted]"}'],
		["x-api-key: k1 sent", "x-api-key: [redacted] sent"],
		["db_credentials=u:p", "db_credentials=[redacted]"],
	])("masks %s", (raw, expected) => {
		expect(quoteSafely(raw)).toBe(expected)
	})

	it.each([
		// Plural `tokens` is a usage count, not a credential.
		"usage output_tokens=40 input_tokens=12",
		"tokens used: 40",
		"secret santa draw finished",
		"basic auth disabled for /health",
	])("keeps %s", (raw) => {
		expect(quoteSafely(raw)).toBe(raw)
	})

	it("caps long messages", () => {
		const quoted = quoteSafely(Arr.join(Arr.replicate("word", 40), " "))
		expect(quoted.length).toBe(80)
		expect(Str.endsWith("…")(quoted)).toBe(true)
	})
})

describe("MAP-03 — consistent dependency spelling", () => {
	it("flags values that differ only by case", () => {
		const report = telemetry({
			peerValues: [
				{ attributeKey: "peer.service", attributeValue: "tinybird", usageCount: 20 },
				{ attributeKey: "peer.service", attributeValue: "Tinybird", usageCount: 5 },
			],
		})
		const result = check(report, "MAP-03")
		expect(result.status).toBe("fail")
		expect(result.affected[0]).toMatchObject({ name: "peer.service", note: "Tinybird / tinybird" })
	})

	it("does not flag genuinely different dependencies", () => {
		const report = telemetry({
			peerValues: [
				{ attributeKey: "peer.service", attributeValue: "tinybird", usageCount: 20 },
				{ attributeKey: "peer.service", attributeValue: "clickhouse", usageCount: 5 },
			],
		})
		expect(check(report, "MAP-03").status).toBe("pass")
	})
})
