import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import { type ExposureRead, catchAllServices, exposureArea } from "./security"

const lastSeen = DateTime.makeUnsafe("2026-11-10T12:00:00Z")

const source = (clientAddress: string, overrides: Partial<ExposureRead["sources"][number]>) => ({
	clientAddress,
	requests: 10,
	signatures: 2,
	scanner: "",
	userAgent: "",
	lastSeen,
	agent: "",
	probed: [],
	denied: 0,
	passedDenialSeconds: 0,
	stages: [],
	...overrides,
})

const read = (sources: ExposureRead["sources"]): ExposureRead => ({
	_tag: "read",
	signatures: [
		{ signature: "/.env", service: "api", requests: 20, inPath: 20, answered: 0, sources: 2, lastSeen },
	],
	exposed: [],
	sources,
})

describe("exposureArea", () => {
	it("names every attack-chain source in one note, with why", () => {
		const result = exposureArea(
			read([
				source("192.0.2.61", { scanner: "Nuclei", agent: "ARTEX" }),
				source("198.51.100.40", { stages: ["sweep", "exploit", "persisted"] }),
				source("203.0.113.7", { stages: ["sweep", "exploit"] }),
			]),
		)
		expect(result.notes).toEqual([
			"2 sources ran an automated attack chain: 192.0.2.61 (sent the ARTEX user agent); 198.51.100.40 (probed three or more categories, tried traversal or exploit paths, was answered again after being refused). Block them at the edge and check what the services they reached answered.",
		])
	})

	it("adds no note when no source ran a chain", () => {
		expect(exposureArea(read([source("203.0.113.7", { stages: ["sweep"] })])).notes).toEqual([])
	})
})

describe("catchAllServices", () => {
	const signature = (token: string, inPath: number, answered: number) => ({
		signature: token,
		service: "web",
		requests: 4,
		inPath,
		answered,
		sources: 1,
		lastSeen,
	})

	it("ignores probes sent only in the query when measuring the share answered", () => {
		// The SPA serves every probed path; `/?page=/etc/passwd` never reached a path.
		const rows = [
			signature("/.env", 4, 4),
			signature("/.git/", 4, 4),
			signature("/server-status", 4, 4),
			signature("/etc/passwd", 0, 0),
		]
		expect(catchAllServices(rows)).toEqual([{ service: "web", answered: 3, probed: 3 }])
	})

	it("keeps a service that refuses a probed path out", () => {
		const rows = [
			signature("/.env", 4, 4),
			signature("/.git/", 4, 4),
			signature("/server-status", 4, 4),
			signature("/actuator/env", 4, 0),
		]
		expect(catchAllServices(rows)).toEqual([])
	})
})
