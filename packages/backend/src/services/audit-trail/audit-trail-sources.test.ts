import { describe, expect, it } from "vitest"
import type { IntegrationEntry, IntegrationResource } from "@maple/domain/integration-inventory"
import { Array as Arr, Option } from "effect"
import { auditTrailSources } from "./audit-trail-sources"

const resource = (overrides: Partial<IntegrationResource>): IntegrationResource => ({
	kind: "drain",
	name: "logs",
	status: "healthy",
	lastSuccessAt: null,
	lastError: null,
	note: null,
	...overrides,
})

const entry = (overrides: Partial<IntegrationEntry>): IntegrationEntry => ({
	provider: "vercel",
	status: "healthy",
	account: "Acme",
	connectedAt: 1,
	problem: null,
	feeds: [],
	resources: [],
	...overrides,
})

const sourceOf = (sources: ReturnType<typeof auditTrailSources>, provider: string) =>
	Option.getOrUndefined(Arr.findFirst(sources, (source) => source.provider === provider))

const stateOf = (sources: ReturnType<typeof auditTrailSources>, provider: string) =>
	sourceOf(sources, provider)?.state

describe("auditTrailSources", () => {
	it("lists Maple as built in even before it has recorded anything", () => {
		const sources = auditTrailSources([], { integrations: [], available: [] })
		expect(sources[0]).toEqual({
			provider: "maple",
			state: "built_in",
			account: null,
			problem: null,
			events: 0,
			lastEventAt: null,
		})
	})

	it("reads a connected Vercel team without the audit drain as off", () => {
		const sources = auditTrailSources([], {
			integrations: [entry({ resources: [resource({ name: "logs" })] })],
			available: [],
		})
		expect(stateOf(sources, "vercel")).toBe("off")
	})

	it("reads an audit drain that is on but has sent nothing as waiting, and one with events as receiving", () => {
		const inventory = {
			integrations: [entry({ resources: [resource({ name: "audit log" })] })],
			available: [],
		}
		expect(stateOf(auditTrailSources([], inventory), "vercel")).toBe("waiting")
		expect(
			stateOf(
				auditTrailSources([{ provider: "vercel", events: 4, lastEventAt: 5 }], inventory),
				"vercel",
			),
		).toBe("receiving")
	})

	it("says why a broken feed fails", () => {
		const sources = auditTrailSources([], {
			integrations: [
				entry({
					provider: "gcp",
					account: "project acme-prod",
					resources: [
						resource({
							kind: "logs",
							name: "project acme-prod",
							status: "failing",
							lastError: "sink missing",
						}),
					],
				}),
			],
			available: [],
		})
		const gcp = sourceOf(sources, "gcp")
		expect(gcp?.state).toBe("failing")
		expect(gcp?.problem).toBe("sink missing")
		expect(gcp?.account).toBe("project acme-prod")
	})

	it("reads Google Cloud with log forwarding off as off: audit events ride the log sink", () => {
		const sources = auditTrailSources([], {
			integrations: [entry({ provider: "gcp", resources: [resource({ kind: "metrics" })] })],
			available: [],
		})
		expect(stateOf(sources, "gcp")).toBe("off")
	})

	it("keeps a platform a newer writer added, so its events are not unaccounted for", () => {
		const sources = auditTrailSources([{ provider: "github", events: 2, lastEventAt: 9 }], null)
		expect(Arr.map(sources, (source) => source.provider)).toEqual([
			"maple",
			"vercel",
			"gcp",
			"aws",
			"github",
		])
		expect(stateOf(sources, "github")).toBe("receiving")
	})

	it("reads AWS as feeding through its audit log resource, and off without one", () => {
		const inventory = (resources: ReadonlyArray<IntegrationResource>) => ({
			integrations: [entry({ provider: "aws", resources })],
			available: [],
		})
		const auditLog = [resource({ kind: "audit log" })]
		expect(stateOf(auditTrailSources([], inventory(auditLog)), "aws")).toBe("waiting")
		expect(
			stateOf(
				auditTrailSources([{ provider: "aws", events: 4, lastEventAt: 9 }], inventory(auditLog)),
				"aws",
			),
		).toBe("receiving")
		expect(stateOf(auditTrailSources([], inventory([resource({ kind: "role" })])), "aws")).toBe("off")
	})
})
