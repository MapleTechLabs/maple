import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { StatusPageComponentId, StatusPageId } from "./primitives"
import {
	applyOverlay,
	contrastRatio,
	DEFAULT_STATUS_PAGE_THEME,
	decodeStatusPageSnapshotJson,
	resolveStatusPageTheme,
	type StatusPageTheme,
	themeContrastIssue,
	dayState,
	deriveComponentStatus,
	fillDays,
	lastDays,
	overallStatus,
	overlayIncidentId,
	pageFreshness,
	sha256Base64Url,
	STATUS_PAGE_STALE_AFTER_MS,
	type StatusPageOverlayEntry,
	type StatusPageSnapshot,
	uptimePercent,
} from "./status-page"

const API = StatusPageComponentId.make("22222222-2222-4222-8222-222222222222")
const NOW = Date.UTC(2026, 9, 28, 12)

const snapshot = (overrides: Partial<StatusPageSnapshot> = {}): StatusPageSnapshot => ({
	schemaVersion: 1,
	pageId: StatusPageId.make("11111111-1111-4111-8111-111111111111"),
	revision: 3,
	generatedAt: NOW,
	page: {
		name: "Acme",
		slug: "acme",
		description: null,
		websiteUrl: null,
		logoUrl: null,
		theme: DEFAULT_STATUS_PAGE_THEME,
		showPoweredBy: true,
	},
	breakGlassTokenSha256: null,
	components: [
		{
			id: API,
			name: "API",
			description: null,
			group: null,
			status: "operational",
			baseStatus: "operational",
			showUptime: true,
			monitored: true,
			days: [{ day: "2026-10-28", checks: 10, failures: 0, downChecks: 0 }],
		},
	],
	incidents: [],
	...overrides,
})

describe("deriveComponentStatus", () => {
	it("is a major outage while the monitor is down, whatever the override says", () => {
		expect(
			deriveComponentStatus({ monitorStatus: "down", manualStatus: "degraded", incidentStatuses: [] }),
		).toBe("major_outage")
	})

	it("takes the worst of the override and active incidents when the monitor is up", () => {
		expect(
			deriveComponentStatus({
				monitorStatus: "up",
				manualStatus: "maintenance",
				incidentStatuses: ["degraded"],
			}),
		).toBe("degraded")
		expect(deriveComponentStatus({ monitorStatus: null, manualStatus: null, incidentStatuses: [] })).toBe(
			"operational",
		)
	})
})

describe("bars", () => {
	it("colours a day by its worst moment and reports uptime as the share of checks not down", () => {
		expect(dayState({ day: "2026-10-28", checks: 0, failures: 0, downChecks: 0 })).toBe("none")
		expect(dayState({ day: "2026-10-28", checks: 10, failures: 1, downChecks: 0 })).toBe("degraded")
		expect(dayState({ day: "2026-10-28", checks: 10, failures: 3, downChecks: 2 })).toBe("down")
		expect(
			uptimePercent([
				{ day: "2026-10-27", checks: 100, failures: 0, downChecks: 0 },
				{ day: "2026-10-28", checks: 100, failures: 2, downChecks: 1 },
			]),
		).toBe(99.5)
		expect(uptimePercent([])).toBeNull()
	})

	it("fills a window of days ending today, oldest first, with empty days where nothing ran", () => {
		const days = lastDays(NOW, 3)
		expect(days).toEqual(["2026-10-26", "2026-10-27", "2026-10-28"])
		expect(fillDays(days, [{ day: "2026-10-27", checks: 4, failures: 0, downChecks: 0 }])).toEqual([
			{ day: "2026-10-26", checks: 0, failures: 0, downChecks: 0 },
			{ day: "2026-10-27", checks: 4, failures: 0, downChecks: 0 },
			{ day: "2026-10-28", checks: 0, failures: 0, downChecks: 0 },
		])
	})
})

describe("decodeStatusPageSnapshotJson", () => {
	it("reads a snapshot published before themes existed with the default theme", () => {
		// JSON drops the undefined theme, as an old snapshot never had one.
		const legacy = JSON.stringify({
			...snapshot(),
			page: { ...snapshot().page, theme: undefined, brandColor: "#123456" },
		})
		const decoded = decodeStatusPageSnapshotJson(legacy)
		expect(Option.isSome(decoded)).toBe(true)
		expect(Option.getOrThrow(decoded).page.theme).toEqual(DEFAULT_STATUS_PAGE_THEME)
	})
})

describe("pageFreshness", () => {
	const beat = (at: number, probesSeenAt: number | null = at) => ({ at, probesSeenAt })

	it("stays live on a quiet healthy page long after its last publish, while the sweep and probes run", () => {
		const later = NOW + 60 * 60_000
		expect(
			pageFreshness({ snapshot: snapshot(), heartbeat: beat(later - 30_000), nowMs: later })._tag,
		).toBe("live")
	})

	it("says delayed when the probes stop, even though the publisher still beats", () => {
		const stale = NOW - STATUS_PAGE_STALE_AFTER_MS - 1
		expect(pageFreshness({ snapshot: snapshot(), heartbeat: beat(NOW, stale), nowMs: NOW })).toEqual({
			_tag: "delayed",
			updatedAt: stale,
		})
	})

	it("says delayed when the publisher stops, and ignores probes on a page with no monitors", () => {
		const later = NOW + STATUS_PAGE_STALE_AFTER_MS + 1
		expect(pageFreshness({ snapshot: snapshot(), heartbeat: null, nowMs: later })._tag).toBe("delayed")
		// A just-published page cannot vouch for its monitors without a probe time.
		expect(pageFreshness({ snapshot: snapshot(), heartbeat: null, nowMs: NOW })._tag).toBe("delayed")
		expect(pageFreshness({ snapshot: snapshot(), heartbeat: beat(NOW, null), nowMs: NOW })._tag).toBe(
			"delayed",
		)
		// A monitored component that hides its bars still counts as monitored.
		const hidden = snapshot({
			components: snapshot().components.map((component) => ({
				...component,
				showUptime: false,
				days: [],
			})),
		})
		expect(pageFreshness({ snapshot: hidden, heartbeat: beat(NOW, 0), nowMs: NOW })._tag).toBe("delayed")
		const manualOnly = snapshot({
			components: snapshot().components.map((component) => ({
				...component,
				monitored: false,
				days: [],
			})),
		})
		expect(
			pageFreshness({ snapshot: manualOnly, heartbeat: beat(NOW, 0), nowMs: NOW + 60_000 })._tag,
		).toBe("live")
	})
})

describe("applyOverlay", () => {
	it("opens an incident from a break-glass entry, follows later entries for it, and marks components", () => {
		const opened = {
			id: "e1",
			at: NOW + 1_000,
			incidentId: null,
			title: "API errors",
			status: "investigating" as const,
			impact: "major" as const,
			body: "We are looking into elevated errors.",
			componentIds: [API],
		}
		const followUp = {
			...opened,
			id: "e2",
			at: NOW + 2_000,
			incidentId: overlayIncidentId("e1"),
			title: null,
			status: "identified" as const,
			body: "A bad deploy; rolling back.",
			componentIds: [],
		}
		// Stored out of order on purpose: entries apply by time.
		const merged = applyOverlay(snapshot(), { entries: [followUp, opened] })
		expect(merged.incidents).toHaveLength(1)
		const incident = merged.incidents[0]
		expect(incident?.title).toBe("API errors")
		expect(incident?.status).toBe("identified")
		expect(incident?.updates.map((update) => update.body)).toEqual([
			"A bad deploy; rolling back.",
			"We are looking into elevated errors.",
		])
		expect(merged.components[0]?.status).toBe("partial_outage")
		expect(overallStatus(merged)).toBe("partial_outage")
	})

	it("stops marking components once the incident is resolved", () => {
		const merged = applyOverlay(snapshot(), {
			entries: [
				{
					id: "e1",
					at: NOW,
					incidentId: null,
					title: "Blip",
					status: "resolved",
					impact: "critical",
					body: "Recovered.",
					componentIds: [API],
				},
			],
		})
		expect(merged.incidents[0]?.resolvedAt).toBe(NOW)
		expect(overallStatus(merged)).toBe("operational")
	})

	const criticalIncident = {
		id: "inc-1",
		kind: "incident" as const,
		title: "Checkout down",
		impact: "critical" as const,
		status: "identified" as const,
		startedAt: NOW,
		resolvedAt: null,
		scheduledStart: null,
		scheduledEnd: null,
		componentIds: [API],
		openedByOverlayEntryId: null,
		updates: [],
	}
	const note = (overrides: Partial<StatusPageOverlayEntry> = {}): StatusPageOverlayEntry => ({
		id: "e9",
		at: NOW + 1_000,
		incidentId: "inc-1",
		title: null,
		status: null,
		impact: null,
		body: "Still working on it.",
		componentIds: [],
		...overrides,
	})

	it("keeps an incident's status and impact when an update leaves them unchanged", () => {
		const merged = applyOverlay(snapshot({ incidents: [criticalIncident] }), { entries: [note()] })
		expect(merged.incidents[0]?.impact).toBe("critical")
		expect(merged.incidents[0]?.status).toBe("identified")
		expect(merged.components[0]?.status).toBe("major_outage")
	})

	it("lowers components again when the overlay resolves an incident the snapshot already applied", () => {
		const applied = snapshot({
			incidents: [criticalIncident],
			components: snapshot().components.map((component) => ({
				...component,
				status: "major_outage" as const,
			})),
		})
		const merged = applyOverlay(applied, { entries: [note({ status: "resolved" })] })
		expect(merged.components[0]?.status).toBe("operational")
		expect(overallStatus(merged)).toBe("operational")
	})

	it("ignores an incident status posted to maintenance", () => {
		const maintenance = {
			...criticalIncident,
			kind: "maintenance" as const,
			status: "in_progress" as const,
		}
		const merged = applyOverlay(snapshot({ incidents: [maintenance] }), {
			entries: [note({ status: "investigating" })],
		})
		expect(merged.incidents[0]?.status).toBe("in_progress")
		expect(merged.components[0]?.status).toBe("maintenance")
	})

	it("skips entries the snapshot already imported, and routes follow-ups to the incident they opened", () => {
		const imported = {
			...criticalIncident,
			id: "db-uuid",
			openedByOverlayEntryId: "e1",
			updates: [
				{
					id: "u1",
					status: "identified" as const,
					body: "Imported.",
					at: NOW,
					source: "break_glass" as const,
					overlayEntryId: "e1",
				},
			],
		}
		const merged = applyOverlay(snapshot({ incidents: [imported] }), {
			entries: [
				note({ id: "e1", incidentId: null, title: "Checkout down", body: "Imported." }),
				note({ id: "e2", incidentId: overlayIncidentId("e1"), status: "resolved" }),
			],
		})
		expect(merged.incidents).toHaveLength(1)
		expect(merged.incidents[0]?.updates.map((update) => update.body)).toEqual([
			"Still working on it.",
			"Imported.",
		])
		expect(merged.incidents[0]?.status).toBe("resolved")
	})
})

describe("sha256Base64Url", () => {
	it("matches the known digest of a value, without padding", async () => {
		expect(await sha256Base64Url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0")
	})
})

describe("contrastRatio", () => {
	it("matches known WCAG pairs", () => {
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5)
		expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2)
		expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2)
		expect(contrastRatio("#ffffff", "#777777")).toBe(contrastRatio("#777777", "#ffffff"))
	})
})

describe("resolveStatusPageTheme", () => {
	const theme = { ...DEFAULT_STATUS_PAGE_THEME }

	it("auto applies the accent but ignores the colour overrides", () => {
		const resolved = resolveStatusPageTheme({
			...theme,
			accent: "#1D4ED8",
			background: "#123456",
			text: "#fedcba",
		})
		expect(resolved.appearance).toBe("auto")
		// A deep blue reads on white, not on near-black, so only the light mode takes it.
		expect(resolved.light.link).toBe("#1d4ed8")
		expect(resolved.dark.link).toBe(resolved.dark.fg)
		expect(resolved.light.bg).toBe(resolveStatusPageTheme(theme).light.bg)
		expect(resolved.dark.fg).toBe(resolveStatusPageTheme(theme).dark.fg)
	})

	it("a forced appearance replaces that mode's colours only", () => {
		const resolved = resolveStatusPageTheme({
			...theme,
			appearance: "dark",
			background: "#101820",
			text: "#f0f0f0",
			card: "#18222c",
			border: "#2a3440",
		})
		expect(resolved.dark).toMatchObject({
			bg: "#101820",
			fg: "#f0f0f0",
			card: "#18222c",
			line: "#2a3440",
		})
		expect(resolved.light.bg).toBe(resolveStatusPageTheme(theme).light.bg)
	})

	it("keeps the preset's status colours whatever the overrides", () => {
		const base = resolveStatusPageTheme({ ...theme, preset: "midnight", appearance: "light" })
		const custom = resolveStatusPageTheme({
			...theme,
			preset: "midnight",
			appearance: "light",
			accent: "#ff0000",
			background: "#eeeeee",
		})
		expect(custom.light.ok).toBe(base.light.ok)
		expect(custom.light.major).toBe(base.light.major)
	})

	it("presets differ and carry radius and font", () => {
		const paper = resolveStatusPageTheme({ ...theme, preset: "paper", radius: "lg", font: "serif" })
		expect(paper.light.bg).not.toBe(resolveStatusPageTheme(theme).light.bg)
		expect(paper.radiusPx).toBeGreaterThan(resolveStatusPageTheme(theme).radiusPx)
		expect(paper.fontStack).toContain("serif")
		expect(resolveStatusPageTheme({ ...theme, radius: "none" }).radiusPx).toBe(0)
	})
})

describe("theme readability", () => {
	const theme = (overrides: Partial<StatusPageTheme>): StatusPageTheme => ({
		...DEFAULT_STATUS_PAGE_THEME,
		...overrides,
	})

	it("drops an accent that would be unreadable on a mode's background, keeping it where it reads", () => {
		// Light lavender reads on the dark background but not on the light one.
		const resolved = resolveStatusPageTheme(theme({ accent: "#a5b4fc" }))
		expect(resolved.dark.link).toBe("#a5b4fc")
		expect(resolved.light.link).toBe(resolved.light.fg)
		// Carried over to Paper (light), it falls back instead of rendering at 1.88:1.
		const paper = resolveStatusPageTheme(
			theme({ preset: "paper", appearance: "light", accent: "#a5b4fc" }),
		)
		expect(contrastRatio(paper.light.link, paper.light.bg)).toBeGreaterThanOrEqual(4.5)
	})

	it("uses the accent for the site name and footer only where it reads, else the muted colour", () => {
		const resolved = resolveStatusPageTheme(theme({ appearance: "light", accent: "#a5b4fc" }))
		expect(resolved.light.secondary).toBe(resolved.light.muted)
		expect(resolveStatusPageTheme(theme({ appearance: "dark", accent: "#a5b4fc" })).dark.secondary).toBe(
			"#a5b4fc",
		)
	})

	it("keeps muted text readable when a custom text colour only just passes", () => {
		const resolved = resolveStatusPageTheme(
			theme({ appearance: "light", text: "#767676", background: "#ffffff", card: "#ffffff" }),
		)
		expect(contrastRatio(resolved.light.muted, resolved.light.bg)).toBeGreaterThanOrEqual(4.5)
		expect(contrastRatio(resolved.light.muted, resolved.light.card)).toBeGreaterThanOrEqual(4.5)
	})

	it("keeps every preset's status text readable on its background and cards", () => {
		const presets = ["default", "mono", "midnight", "paper"] as const
		const worst = presets.flatMap((preset) => {
			const resolved = resolveStatusPageTheme(theme({ preset }))
			return [resolved.light, resolved.dark].flatMap((tokens) =>
				[tokens.ok, tokens.degraded, tokens.partial, tokens.major].map((colour) =>
					Math.min(contrastRatio(colour, tokens.bg), contrastRatio(colour, tokens.card)),
				),
			)
		})
		expect(Math.min(...worst)).toBeGreaterThanOrEqual(4.5)
	})
})

describe("themeContrastIssue", () => {
	const presets = ["default", "mono", "midnight", "paper"] as const
	const appearances = ["auto", "light", "dark"] as const

	it("passes every preset in every appearance", () => {
		const issues = presets.flatMap((preset) =>
			appearances.map((appearance) =>
				themeContrastIssue({ ...DEFAULT_STATUS_PAGE_THEME, preset, appearance }),
			),
		)
		expect(issues.filter((issue) => issue !== null)).toEqual([])
	})

	it("flags #777777 text on a white background at 4.48:1", () => {
		const issue = themeContrastIssue({
			...DEFAULT_STATUS_PAGE_THEME,
			appearance: "light",
			background: "#ffffff",
			text: "#777777",
		})
		expect(issue).toContain("4.48:1")
	})

	it("flags text that is readable on the background but not on cards", () => {
		const issue = themeContrastIssue({
			...DEFAULT_STATUS_PAGE_THEME,
			appearance: "light",
			text: "#595959",
			card: "#888888",
		})
		expect(issue).toMatch(/^Text on cards/u)
	})

	it("accepts #767676 on white, just over the line", () => {
		expect(
			themeContrastIssue({
				...DEFAULT_STATUS_PAGE_THEME,
				appearance: "light",
				background: "#ffffff",
				text: "#767676",
				card: "#ffffff",
			}),
		).toBeNull()
	})

	it("ignores unreadable overrides in auto, where they do not apply", () => {
		expect(
			themeContrastIssue({ ...DEFAULT_STATUS_PAGE_THEME, background: "#ffffff", text: "#fefefe" }),
		).toBeNull()
	})
})
