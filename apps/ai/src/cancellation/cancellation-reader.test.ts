import { describe, expect, it } from "vitest"
import { normalizeAnswer } from "./cancellation-reader"

const context = { surveyAnswer: null, companyClues: true }

const answer = {
	company: null,
	findings: [],
	verdict: "agree" as const,
	category: null,
	reason: null,
	conclusion: "Stopped sending after the trial.",
}

describe("normalizeAnswer", () => {
	it("keeps an override that names its reason, filed under other when it gave no label", () => {
		const read = normalizeAnswer({ ...answer, verdict: "override", reason: " Needed SSO " }, "m", context)
		expect([read.verdict, read.reason, read.category]).toEqual(["override", "Needed SSO", "other"])
		expect(
			normalizeAnswer(
				{ ...answer, verdict: "override", reason: "Needed SSO", category: "missing_features" },
				"m",
				context,
			).category,
		).toBe("missing_features")
	})

	it("reads an override without a reason, or a label on an agreement, as plain agreement", () => {
		for (const read of [
			normalizeAnswer({ ...answer, verdict: "override", reason: "  ", category: "cost" }, "m", context),
			normalizeAnswer({ ...answer, reason: "Cost", category: "cost" }, "m", context),
		]) {
			expect([read.verdict, read.reason, read.category]).toEqual(["agree", null, null])
		}
	})

	it("drops blank findings and keeps at most three", () => {
		const findings = [" a ", "", "b", "  ", "c", "d", "e"]
		expect(normalizeAnswer({ ...answer, findings }, "m", context).findings).toEqual(["a", "b", "c"])
	})

	it('reads a field the model wrote out as "null" or "unknown" as empty', () => {
		const company = {
			name: "Acme",
			oneLiner: "null",
			location: " Unknown ",
			confidence: "low" as const,
			basis: "domain",
		}
		const read = normalizeAnswer({ ...answer, company, findings: ["null", "Real one."] }, "m", context)
		expect([read.company?.oneLiner, read.company?.location, read.findings]).toEqual([
			null,
			null,
			["Real one."],
		])
	})

	it("drops a company guess whose name is only punctuation and a placeholder", () => {
		for (const name of [": null", "null,", "-", " Unknown. "]) {
			const company = {
				name,
				oneLiner: null,
				location: null,
				confidence: "medium" as const,
				basis: "x",
			}
			expect(normalizeAnswer({ ...answer, company }, "m", context).company).toBeNull()
		}
	})

	it("keeps a company named only in non-Latin letters", () => {
		const company = {
			name: "株式会社サンプル",
			oneLiner: null,
			location: null,
			confidence: "medium" as const,
			basis: "x",
		}
		expect(normalizeAnswer({ ...answer, company }, "m", context).company?.name).toBe("株式会社サンプル")
	})

	it("drops a low-confidence guess with no company domain or homepage behind it", () => {
		const company = {
			name: "Acme",
			oneLiner: null,
			location: null,
			confidence: "low" as const,
			basis: "org name",
		}
		expect(
			normalizeAnswer({ ...answer, company }, "m", { ...context, companyClues: false }).company,
		).toBeNull()
		expect(normalizeAnswer({ ...answer, company }, "m", context).company?.name).toBe("Acme")
	})

	it("files an override under the category the customer's survey answer names, over other", () => {
		const read = normalizeAnswer(
			{ ...answer, verdict: "override", reason: "Overage bill", category: "other" },
			"m",
			{ ...context, surveyAnswer: "too_expensive" },
		)
		expect(read.category).toBe("cost")
	})

	it("drops a company guess without a name", () => {
		const company = { name: " ", oneLiner: "x", location: null, confidence: "low" as const, basis: "y" }
		expect(normalizeAnswer({ ...answer, company }, "m", context).company).toBeNull()
		expect(
			normalizeAnswer({ ...answer, company: { ...company, name: "Acme", location: " " } }, "m", context)
				.company,
		).toEqual({ ...company, name: "Acme", location: null })
	})
})
