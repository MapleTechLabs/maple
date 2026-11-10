import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import { type ExposureRead, exposureArea } from "./security"

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
	signatures: [{ signature: "/.env", service: "api", requests: 20, answered: 0, sources: 2, lastSeen }],
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
