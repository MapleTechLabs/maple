import { describe, expect, it } from "vitest"
import { riskScore } from "./production"

const rank = (
	findings: ReadonlyArray<{
		readonly name: string
		readonly severity: "critical" | "high" | "medium" | "low" | "unknown"
		readonly relation: "direct" | "dev" | "transitive" | "unknown"
		readonly spans: number
	}>,
) =>
	[...findings].sort((a, b) => riskScore(b, b.spans) - riskScore(a, a.spans)).map((finding) => finding.name)

describe("riskScore", () => {
	it("puts a medium advisory a busy service runs above a high one nothing deploys", () => {
		expect(
			rank([
				{ name: "high, not deployed", severity: "high", relation: "direct", spans: 0 },
				{ name: "medium, in production", severity: "medium", relation: "transitive", spans: 50_000 },
			]),
		).toEqual(["medium, in production", "high, not deployed"])
	})

	it("ranks the same advisory by the traffic that runs it", () => {
		expect(
			rank([
				{ name: "quiet", severity: "high", relation: "transitive", spans: 10 },
				{ name: "busy", severity: "high", relation: "transitive", spans: 1_000_000 },
				{ name: "undeployed", severity: "high", relation: "transitive", spans: 0 },
			]),
		).toEqual(["busy", "quiet", "undeployed"])
	})

	it("keeps a critical advisory first even when it is only a direct dependency nothing deploys", () => {
		expect(
			rank([
				{ name: "low, busy", severity: "low", relation: "transitive", spans: 1_000_000 },
				{ name: "critical, undeployed", severity: "critical", relation: "direct", spans: 0 },
			]),
		).toEqual(["critical, undeployed", "low, busy"])
	})

	it("ranks a dev-only dependency below the same advisory shipped to users", () => {
		expect(
			rank([
				{ name: "dev", severity: "high", relation: "dev", spans: 0 },
				{ name: "transitive", severity: "high", relation: "transitive", spans: 0 },
			]),
		).toEqual(["transitive", "dev"])
	})
})
