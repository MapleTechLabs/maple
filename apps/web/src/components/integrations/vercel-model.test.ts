import { describe, expect, it } from "vitest"
import { VercelDrainStatus, VercelIntegrationStatus } from "@maple/domain/http"
import {
	DEFAULT_VERCEL_DRAFT,
	deploymentStateLabel,
	deploymentTone,
	percentOf,
	draftProblem,
	samplingLabel,
	settingsPatch,
	stoppedByDraft,
	vercelHealth,
	vercelIssues,
	type VercelDraft,
} from "./vercel-model"

const drain = (status: VercelDrainStatus["status"], lastError: string | null = null) =>
	new VercelDrainStatus({ id: `drn_${status}`, status, lastError })

const connected = (overrides: Partial<ConstructorParameters<typeof VercelIntegrationStatus>[0]> = {}) =>
	new VercelIntegrationStatus({
		connected: true,
		team: { id: "team_1", slug: "acme", name: "Acme" },
		projectScope: "all",
		projectIds: [],
		samplingRate: 1,
		logsEnabled: true,
		tracesEnabled: true,
		drains: { logs: drain("enabled"), traces: drain("enabled") },
		projects: [],
		authFailed: false,
		connectedAt: 1,
		lastSuccessAt: 2,
		lastError: null,
		...overrides,
	})

const names = new Map([
	["prj_a", "web"],
	["prj_b", "docs"],
	["prj_c", "api"],
])

describe("settingsPatch", () => {
	it("sends nothing when nothing changed", () => {
		expect(settingsPatch(DEFAULT_VERCEL_DRAFT, DEFAULT_VERCEL_DRAFT)).toEqual({})
	})

	it("sends the project list with a switch to picked projects", () => {
		const draft: VercelDraft = { ...DEFAULT_VERCEL_DRAFT, projectScope: "some", projectIds: ["prj_a"] }
		expect(settingsPatch(DEFAULT_VERCEL_DRAFT, draft)).toEqual({
			projectScope: "some",
			projectIds: ["prj_a"],
		})
	})

	it("ignores a reordered project list", () => {
		const saved: VercelDraft = {
			...DEFAULT_VERCEL_DRAFT,
			projectScope: "some",
			projectIds: ["prj_a", "prj_b"],
		}
		expect(settingsPatch(saved, { ...saved, projectIds: ["prj_b", "prj_a"] })).toEqual({})
	})

	it("sends only the toggled signal and the new rate", () => {
		expect(
			settingsPatch(DEFAULT_VERCEL_DRAFT, {
				...DEFAULT_VERCEL_DRAFT,
				tracesEnabled: false,
				samplingRate: 0.25,
			}),
		).toEqual({ tracesEnabled: false, samplingRate: 0.25 })
	})
})

describe("stoppedByDraft", () => {
	it("needs no confirmation for changes that only add", () => {
		const saved: VercelDraft = { ...DEFAULT_VERCEL_DRAFT, tracesEnabled: false, samplingRate: 0.5 }
		expect(stoppedByDraft(saved, DEFAULT_VERCEL_DRAFT, names)).toEqual([])
	})

	it("names the projects dropped when narrowing from all", () => {
		const draft: VercelDraft = { ...DEFAULT_VERCEL_DRAFT, projectScope: "some", projectIds: ["prj_a"] }
		expect(stoppedByDraft(DEFAULT_VERCEL_DRAFT, draft, names)).toEqual([
			"Projects no longer forwarded: docs, api",
		])
	})

	it("says a signal switched off deletes its drain, and lowered sampling", () => {
		const draft: VercelDraft = { ...DEFAULT_VERCEL_DRAFT, logsEnabled: false, samplingRate: 0.1 }
		expect(stoppedByDraft(DEFAULT_VERCEL_DRAFT, draft, names)).toEqual([
			"Logs: the Maple logs drain is deleted",
			"Sampling drops to 10% of events",
		])
	})
})

describe("draftProblem", () => {
	it("refuses a draft that forwards nothing", () => {
		expect(draftProblem({ ...DEFAULT_VERCEL_DRAFT, logsEnabled: false, tracesEnabled: false })).toBe(
			"Forward logs, traces or both.",
		)
		expect(draftProblem({ ...DEFAULT_VERCEL_DRAFT, projectScope: "some" })).toBe(
			"Pick at least one project.",
		)
		expect(draftProblem(DEFAULT_VERCEL_DRAFT)).toBeNull()
	})
})

describe("vercelIssues", () => {
	it("reports only the token while it is rejected", () => {
		const issues = vercelIssues(
			connected({ authFailed: true, drains: { logs: drain("missing"), traces: null } }),
		)
		expect(issues.map((issue) => issue.fix)).toEqual(["token"])
	})

	it("reports broken drains of enabled signals with Vercel's reason", () => {
		const issues = vercelIssues(
			connected({
				tracesEnabled: false,
				drains: { logs: drain("errored", "endpoint returned 401"), traces: drain("missing") },
			}),
		)
		expect(issues).toHaveLength(1)
		expect(issues[0]?.title).toBe("The logs drain is failing on Vercel")
		expect(issues[0]?.vercelError).toBe("endpoint returned 401")
	})

	it("re-keys a failing drain and re-creates a deleted one", () => {
		const issues = vercelIssues(
			connected({ drains: { logs: drain("errored"), traces: drain("missing") } }),
		)
		expect(issues.map((issue) => issue.description)).toEqual([
			"Vercel can't deliver to Maple, usually because the ingest key changed. Re-applying the settings sends Maple's current ingest key to the drain.",
			"Re-applying the settings creates it again on Vercel.",
		])
	})

	it("treats an enabled signal without a drain as broken", () => {
		expect(vercelIssues(connected({ drains: { logs: drain("enabled"), traces: null } }))).toHaveLength(1)
	})
})

describe("vercelHealth", () => {
	it("waits for the first sync, then follows the issues", () => {
		expect(vercelHealth(connected({ lastSuccessAt: null }))).toBe("pending")
		expect(vercelHealth(connected())).toBe("healthy")
		expect(
			vercelHealth(connected({ drains: { logs: drain("disabled"), traces: drain("enabled") } })),
		).toBe("attention")
	})
})

describe("samplingLabel", () => {
	it("reads full sampling as everything", () => {
		expect(samplingLabel(1)).toBe("Everything")
		expect(samplingLabel(0.05)).toBe("5% of events")
	})
})

describe("deploymentTone", () => {
	it("reads Vercel's states in any case", () => {
		expect(deploymentTone("READY")).toBe("ok")
		expect(deploymentTone("error")).toBe("crit")
		expect(deploymentTone("BUILDING")).toBe("info")
		expect(deploymentTone("CANCELED")).toBe("neutral")
		expect(deploymentStateLabel("CANCELED")).toBe("Canceled")
	})
})

describe("percentOf", () => {
	it("has no share without a denominator", () => {
		expect(percentOf(3, 0)).toBeNull()
		expect(percentOf(1, 4)).toBe(25)
	})
})
