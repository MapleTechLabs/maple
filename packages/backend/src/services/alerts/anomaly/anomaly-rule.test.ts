import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import {
	assignAnomalyRule,
	anomalyGroupLabel,
	describeAnomaly,
	type AnomalyIncidentScope,
	type AnomalyRuleCandidate,
} from "./anomaly-rule"

const rule = (id: string, overrides: Partial<AnomalyRuleCandidate> = {}): AnomalyRuleCandidate => ({
	id,
	serviceNames: [],
	environments: [],
	anomalySignals: [],
	lowestSeverityCode: 1,
	...overrides,
})

const incident = (overrides: Partial<AnomalyIncidentScope> = {}): AnomalyIncidentScope => ({
	serviceName: "checkout",
	deploymentEnv: "production",
	signalType: "error_rate",
	severity: "warning",
	...overrides,
})

const assignedId = (
	rules: ReadonlyArray<AnomalyRuleCandidate>,
	scope: AnomalyIncidentScope,
	currentRuleId: string | null = null,
) => Option.getOrNull(Option.map(assignAnomalyRule(rules, scope, currentRuleId), (r) => r.id))

describe("assignAnomalyRule", () => {
	it("gives an incident to the default rule when nothing narrower covers it", () => {
		const rules = [rule("default"), rule("payments", { serviceNames: ["payments"] })]
		assert.strictEqual(assignedId(rules, incident()), "default")
	})

	it("matches each scope field, with an empty list matching everything", () => {
		const byService = rule("svc", { serviceNames: ["checkout"] })
		const byEnv = rule("env", { environments: ["staging"] })
		const bySignal = rule("sig", { anomalySignals: ["latency_p95"] })
		const rules = [byService, byEnv, bySignal]
		assert.strictEqual(assignedId(rules, incident()), "svc")
		assert.strictEqual(
			assignedId(rules, incident({ serviceName: "cart", deploymentEnv: "staging" })),
			"env",
		)
		assert.strictEqual(
			assignedId(rules, incident({ serviceName: "cart", signalType: "latency_p95" })),
			"sig",
		)
		assert.isNull(assignedId(rules, incident({ serviceName: "cart" })))
	})

	it("prefers the rule with more scope fields set", () => {
		const rules = [
			rule("service-only", { serviceNames: ["checkout"] }),
			rule("service-and-env", { serviceNames: ["checkout"], environments: ["production"] }),
			rule("all-three", {
				serviceNames: ["checkout"],
				environments: ["production"],
				anomalySignals: ["error_rate"],
			}),
			rule("default"),
		]
		assert.strictEqual(assignedId(rules, incident()), "all-three")
		assert.strictEqual(assignedId(rules, incident({ signalType: "throughput" })), "service-and-env")
		assert.strictEqual(
			assignedId(rules, incident({ signalType: "throughput", deploymentEnv: "staging" })),
			"service-only",
		)
	})

	it("breaks a specificity tie on the lowest rule id, whatever the input order", () => {
		const b = rule("b-rule", { serviceNames: ["checkout"] })
		const a = rule("a-rule", { environments: ["production"] })
		assert.strictEqual(assignedId([b, a], incident()), "a-rule")
		assert.strictEqual(assignedId([a, b], incident()), "a-rule")
	})

	it("passes a warning over a rule with no warning tier", () => {
		const criticalOnly = rule("critical-checkout", { serviceNames: ["checkout"], lowestSeverityCode: 2 })
		const rules = [criticalOnly, rule("default")]
		assert.strictEqual(assignedId(rules, incident({ severity: "warning" })), "default")
		assert.strictEqual(assignedId(rules, incident({ severity: "critical" })), "critical-checkout")
		assert.isNull(assignedId([criticalOnly], incident({ severity: "warning" })))
	})

	it("keeps an anomaly on its paging rule unless a strictly more specific rule qualifies", () => {
		const fallback = rule("default")
		const byEnv = rule("a-env", { environments: ["production"] })
		const byService = rule("z-checkout", { serviceNames: ["checkout"] })
		const both = rule("both", { serviceNames: ["checkout"], environments: ["production"] })
		const peers = [fallback, byEnv, byService]
		// An equally specific rule, even one with a lower id, does not take it.
		assert.strictEqual(assignedId(peers, incident(), "z-checkout"), "z-checkout")
		// A strictly more specific rule takes it over.
		assert.strictEqual(assignedId(peers, incident(), "default"), "a-env")
		assert.strictEqual(assignedId([...peers, both], incident(), "z-checkout"), "both")
		// A paging rule that no longer qualifies lets the order decide.
		const criticalOnly = rule("z-checkout", { serviceNames: ["checkout"], lowestSeverityCode: 2 })
		assert.strictEqual(assignedId([rule("default"), criticalOnly], incident(), "z-checkout"), "default")
		assert.strictEqual(assignedId([...peers, both], incident(), "deleted-rule"), "both")
	})

	it("assigns nothing when the org has no anomaly rules", () => {
		assert.isNull(assignedId([], incident()))
	})
})

describe("anomalyGroupLabel", () => {
	it("names the service and environment, or the signal when there is no service", () => {
		assert.strictEqual(
			anomalyGroupLabel({
				serviceName: "checkout",
				deploymentEnv: "production",
				signalType: "error_rate",
			}),
			"checkout (production)",
		)
		assert.strictEqual(
			anomalyGroupLabel({ serviceName: "", deploymentEnv: "", signalType: "error_spike" }),
			"error spike",
		)
	})
})

describe("describeAnomaly", () => {
	const base = { serviceName: "checkout", deploymentEnv: "production" }

	it("states each signal in its own unit against the baseline", () => {
		assert.strictEqual(
			describeAnomaly({
				...base,
				signalType: "error_rate",
				lastObservedValue: 0.042,
				baselineMedian: 0.003,
			}),
			"error rate 4.2% vs baseline 0.3% in checkout (production)",
		)
		assert.strictEqual(
			describeAnomaly({
				...base,
				signalType: "latency_p95",
				lastObservedValue: 840,
				baselineMedian: 210,
			}),
			"p95 latency 840ms vs baseline 210ms in checkout (production)",
		)
		assert.strictEqual(
			describeAnomaly({
				...base,
				signalType: "throughput",
				lastObservedValue: 3,
				baselineMedian: 1200,
			}),
			"throughput dropped to 3 rpm vs baseline 1,200 rpm in checkout (production)",
		)
		assert.strictEqual(
			describeAnomaly({ ...base, signalType: "error_spike", lastObservedValue: 42, baselineMedian: 3 }),
			"error spike: 42 errors in 30 min vs baseline 3 in checkout (production)",
		)
	})

	it("omits an empty environment", () => {
		assert.strictEqual(
			describeAnomaly({
				serviceName: "api",
				deploymentEnv: "",
				signalType: "log_volume",
				lastObservedValue: 120,
				baselineMedian: 4,
			}),
			"error log volume 120/min vs baseline 4/min in api",
		)
	})
})
