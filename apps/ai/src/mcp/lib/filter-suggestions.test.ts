import { describe, expect, it } from "vitest"
import { closestMatches, missingFilterHints } from "./filter-suggestions"

describe("closestMatches", () => {
	it("suggests a service the input contains", () => {
		expect(closestMatches("maple-alerting", ["api", "alerting", "ingest"])).toEqual(["alerting"])
	})

	it("suggests the qualified span name for a bare method", () => {
		expect(
			closestMatches("resetAudienceAssignments", [
				"CampaignsV2Handler.resetAudienceAssignments",
				"CampaignsV2Handler.list",
			]),
		).toEqual(["CampaignsV2Handler.resetAudienceAssignments"])
	})

	it("suggests near spellings and other casings, never the exact value", () => {
		expect(closestMatches("stg", ["staging", "stage", "production"])).toEqual(["stage", "staging"])
		expect(closestMatches("Production", ["production"])).toEqual(["production"])
		expect(closestMatches("api", ["api"])).toEqual([])
	})

	it("suggests nothing for an unrelated value", () => {
		expect(closestMatches("banana", ["api", "ingest"])).toEqual([])
	})
})

describe("missingFilterHints", () => {
	it("names the closest service and environment", () => {
		const hints = missingFilterHints(
			{ service: "maple-alerting", environments: ["prod"] },
			{ services: ["alerting", "api"], environments: ["production", "staging"] },
		)
		expect(hints).toEqual([
			'service "maple-alerting" was not seen in this window. Did you mean "alerting"?',
			'environment "prod" was not seen in this window. Did you mean "production"?',
		])
	})

	it("says nothing about values that exist or lists it does not know", () => {
		expect(missingFilterHints({ service: "api", attributeKey: "x" }, { services: ["api"] })).toEqual([])
	})

	it("only claims absence from a complete list", () => {
		expect(
			missingFilterHints({ service: "zzz" }, { services: ["api"], servicesComplete: false }),
		).toEqual([])
		expect(missingFilterHints({ service: "zzz" }, { services: ["api"] })[0]).toContain("list_services")
		expect(
			missingFilterHints(
				{ environments: ["qa-eu-7"] },
				{ environments: ["production"], environmentsComplete: false },
			),
		).toEqual([])
	})

	it("suggests an attribute key and a span name", () => {
		const hints = missingFilterHints(
			{ attributeKey: "deployment.env", spanName: "resetAudienceAssignments" },
			{
				attributeKeys: ["deployment.environment", "http.route"],
				spanNames: ["CampaignsV2Handler.resetAudienceAssignments"],
			},
		)
		expect(hints[0]).toContain('"deployment.environment"')
		expect(hints[1]).toContain('"CampaignsV2Handler.resetAudienceAssignments"')
	})
})
