import { describe, expect, it } from "vitest"
import { Option, String as Str } from "effect"
import {
	DESCRIPTION_MAX_CHARS,
	FINDING_ID_MAX_CHARS,
	LABEL_MAX_CHARS,
	RESOURCE_ID_MAX_CHARS,
	readFinding,
	TITLE_MAX_CHARS,
} from "./finding-read"

const NOW = Date.parse("2026-11-16T12:00:00Z")
const HOUR = 3600_000

const base = {
	findingId: "f-1",
	type: "Recon:EC2/PortProbe",
	title: "Port probe",
	description: "An open port was probed.",
	severity: "medium",
	status: "active",
	resourceType: "Instance",
	resourceId: "i-0abc",
	resourceName: "web",
	occurrences: 3,
	firstSeenAt: NOW - 2 * HOUR,
	lastSeenAt: NOW - HOUR,
	updatedAt: NOW - HOUR,
	detail: {},
} as const

const read = (overrides: Partial<Parameters<typeof readFinding>[0]>) =>
	Option.getOrUndefined(readFinding({ ...base, ...overrides }, NOW))

describe("readFinding", () => {
	it("keeps times at or before now as the service reported them", () => {
		expect(read({})).toMatchObject({
			firstSeenAt: NOW - 2 * HOUR,
			lastSeenAt: NOW - HOUR,
			providerUpdatedAt: NOW - HOUR,
		})
	})

	it("holds a finding dated ahead of now to now, in all three times", () => {
		const year = 365 * 24 * HOUR
		expect(
			read({ firstSeenAt: NOW + year, lastSeenAt: NOW + 2 * year, updatedAt: NOW + 3 * year }),
		).toMatchObject({ firstSeenAt: NOW, lastSeenAt: NOW, providerUpdatedAt: NOW })
		// The update time stands in for a missing sighting, after it was held to now.
		expect(read({ firstSeenAt: undefined, lastSeenAt: undefined, updatedAt: NOW + year })).toMatchObject({
			firstSeenAt: NOW,
			lastSeenAt: NOW,
			providerUpdatedAt: NOW,
		})
	})

	it("cuts long text to what a row keeps", () => {
		const long = Str.repeat(10_000)("x")
		const finding = read({
			type: long,
			title: long,
			description: long,
			resourceType: long,
			resourceId: long,
			resourceName: long,
		})
		expect([
			finding?.type.length,
			finding?.title.length,
			finding?.description?.length,
			finding?.resourceType.length,
			finding?.resourceId.length,
			finding?.resourceName?.length,
		]).toEqual([
			LABEL_MAX_CHARS,
			TITLE_MAX_CHARS,
			DESCRIPTION_MAX_CHARS,
			LABEL_MAX_CHARS,
			RESOURCE_ID_MAX_CHARS,
			LABEL_MAX_CHARS,
		])
	})

	it("never cuts through the middle of a character", () => {
		// The emoji takes two units and straddles the limit: it goes whole.
		const title = `${Str.repeat(TITLE_MAX_CHARS - 1)("x")}\u{1F512}tail`
		expect(read({ title })?.title).toBe(Str.repeat(TITLE_MAX_CHARS - 1)("x"))
	})

	it("drops a finding whose id is too long instead of storing a shortened one", () => {
		expect(read({ findingId: Str.repeat(FINDING_ID_MAX_CHARS)("a") })?.findingId).toHaveLength(
			FINDING_ID_MAX_CHARS,
		)
		expect(read({ findingId: Str.repeat(FINDING_ID_MAX_CHARS + 1)("a") })).toBe(undefined)
	})

	it("stores a count the column can hold, whatever the service sent", () => {
		expect(read({ occurrences: 1e12 })?.occurrences).toBe(2_147_483_647)
		expect(read({ occurrences: 2.7 })?.occurrences).toBe(2)
		expect(read({ occurrences: -4 })?.occurrences).toBe(1)
		expect(read({ occurrences: undefined })?.occurrences).toBe(1)
	})
})
