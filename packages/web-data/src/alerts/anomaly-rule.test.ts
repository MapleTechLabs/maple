import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { anomalyScopeSummary, isDefaultAnomalyRule } from "./anomaly-rule"
import { buildRuleCreateParamsV2, defaultRuleForm, deriveTierIssues } from "./form-utils"
import { switchSignalKind } from "./rule-modes"

const anomalyForm = (overrides: Partial<ReturnType<typeof defaultRuleForm>> = {}) =>
	switchSignalKind({ ...defaultRuleForm(), name: "Checkout anomalies", ...overrides }, "anomaly").form

describe("anomaly rules", () => {
	it("only an unscoped anomaly rule is the default one", () => {
		expect(isDefaultAnomalyRule(anomalyForm())).toBe(true)
		expect(isDefaultAnomalyRule(anomalyForm({ serviceNames: ["checkout"] }))).toBe(false)
		expect(isDefaultAnomalyRule({ ...anomalyForm(), anomalySignals: ["throughput"] })).toBe(false)
		expect(isDefaultAnomalyRule(defaultRuleForm())).toBe(false)
	})

	it("saves both tiers at the severity codes and sends its signals and scope", () => {
		const form = {
			...anomalyForm({ serviceNames: ["checkout"], environments: ["production"] }),
			anomalySignals: ["error_spike" as const],
		}
		const params = buildRuleCreateParamsV2(form)
		expect(params.signal_type).toBe("anomaly")
		expect(params.anomaly_signals).toEqual(["error_spike"])
		expect(params.service_names).toEqual(["checkout"])
		expect(params.environments).toEqual(["production"])
		expect(Arr.map(params.thresholds ?? [], (tier) => [tier.severity, tier.value])).toEqual([
			["warning", 1],
			["critical", 2],
		])
	})

	it("lets an anomaly tier stay unrouted, unlike a threshold rule's critical tier", () => {
		expect(deriveTierIssues(anomalyForm())).toEqual([])
	})

	it("leaving the anomaly kind starts a query from error rate with both tiers' destinations", () => {
		const anomaly = anomalyForm({ serviceNames: ["checkout"] })
		const left = switchSignalKind(anomaly, "builtin").form
		expect(left.signalType).toBe("error_rate")
		expect(left.escalation).toBeNull()
		expect(left.serviceNames).toEqual(["checkout"])
		expect(left.threshold).toBe(defaultRuleForm().threshold)
	})

	it("summarises the scope, counting long lists", () => {
		expect(
			anomalyScopeSummary({
				serviceNames: ["a", "b", "c"],
				environments: [],
				anomalySignals: ["log_volume"],
			}),
		).toBe("3 services · all environments · Log volume")
	})
})
