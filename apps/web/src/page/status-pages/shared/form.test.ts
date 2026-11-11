import { DEFAULT_STATUS_PAGE_THEME } from "@maple/domain/status-page"
import { describe, expect, it } from "vitest"
import {
	emptyIncidentForm,
	endedIssue,
	hasAppearanceIssues,
	hasPageFieldIssues,
	hasSettingsIssues,
	incidentEditIssues,
	incidentIssues,
	isSameSettings,
	type SettingsForm,
	settingsIssues,
	settingsPayload,
	themeFormOf,
	updateFormFor,
} from "./form"
import { incidentId } from "./test-pages"
import { String as Str } from "effect"

const saved: SettingsForm = {
	name: "Acme!",
	slug: "acme",
	description: "",
	websiteUrl: "https://acme.example",
	privacyUrl: "",
	termsUrl: "",
	supportUrl: "",
	logoUrl: "",
	logoDarkUrl: "",
	faviconUrl: "",
	showPoweredBy: true,
	autoIncidents: "off",
	theme: themeFormOf({ ...DEFAULT_STATUS_PAGE_THEME, accent: "#aabbcc" }),
}

describe("isSameSettings", () => {
	it("treats a draft the API stored trimmed and lower-cased as saved", () => {
		const draft = {
			...saved,
			name: "Acme! ",
			websiteUrl: " https://acme.example",
			theme: { ...saved.theme, accent: " #AABBCC" },
		}
		expect(isSameSettings(draft, saved)).toBe(true)
	})

	it("still sees a real change", () => {
		expect(isSameSettings({ ...saved, theme: { ...saved.theme, accent: "#aabbcd" } }, saved)).toBe(false)
		expect(isSameSettings({ ...saved, theme: { ...saved.theme, radius: "lg" } }, saved)).toBe(false)
	})
})

describe("footer links", () => {
	it("sends https links trimmed and blank ones as null", () => {
		const payload = settingsPayload({
			...saved,
			privacyUrl: " https://acme.example/privacy ",
			termsUrl: " ",
		})
		expect(payload.privacy_url).toBe("https://acme.example/privacy")
		expect(payload.terms_url).toBeNull()
	})

	it("refuses links the API would refuse", () => {
		const issues = settingsIssues({
			...saved,
			privacyUrl: "http://acme.example/privacy",
			termsUrl: "javascript:alert(1)",
		})
		expect(issues.privacyUrl).toBe("Use an https URL.")
		expect(issues.termsUrl).toBe("Use an https URL.")
		expect(hasSettingsIssues({ ...saved, termsUrl: "https://acme.example/terms" })).toBe(false)
	})

	it("sees a changed link as unsaved", () => {
		expect(isSameSettings({ ...saved, termsUrl: "https://acme.example/terms" }, saved)).toBe(false)
		expect(isSameSettings({ ...saved, termsUrl: " " }, saved)).toBe(true)
	})
})

describe("URL fields", () => {
	it("refuses what the service refuses: unparseable or not https, on every URL field", () => {
		const issues = settingsIssues({
			...saved,
			websiteUrl: "http://acme.example",
			privacyUrl: "https://acme.example:abc",
			termsUrl: "https://acme.example/terms",
			logoUrl: "",
		})
		expect(issues.websiteUrl).toBe("Use an https URL.")
		expect(issues.privacyUrl).toBe("Use a valid URL, like https://acme.example.")
		expect(issues.termsUrl).toBeNull()
		expect(issues.logoUrl).toBeNull()
	})

	it("marks a bad branding link on the Appearance tab and a bad support link on Settings", () => {
		const badLogo = { ...saved, logoDarkUrl: "http://acme.example/dark.svg" }
		expect(hasAppearanceIssues(badLogo)).toBe(true)
		expect(hasPageFieldIssues(badLogo)).toBe(false)
		const badSupport = { ...saved, supportUrl: "mailto:help@acme.example" }
		expect(hasPageFieldIssues(badSupport)).toBe(true)
		expect(hasAppearanceIssues(badSupport)).toBe(false)
	})

	it("sends the branding links trimmed and blank ones as null", () => {
		const payload = settingsPayload({
			...saved,
			logoDarkUrl: " https://acme.example/dark.svg ",
			faviconUrl: " ",
			supportUrl: "https://acme.example/help",
		})
		expect(payload.logo_dark_url).toBe("https://acme.example/dark.svg")
		expect(payload.favicon_url).toBeNull()
		expect(payload.support_url).toBe("https://acme.example/help")
	})

	it("refuses a link longer than the service stores", () => {
		const long = `https://acme.example/${Str.repeat(2048)("a")}`
		expect(settingsIssues({ ...saved, termsUrl: long }).termsUrl).toBe("Keep it under 2048 characters.")
	})
})

describe("theme settings", () => {
	it("sends the whole theme with blank colours as null", () => {
		const form: SettingsForm = {
			...saved,
			theme: { ...saved.theme, appearance: "dark", background: "#0B0B0B " },
		}
		expect(settingsPayload(form).theme).toEqual({
			...DEFAULT_STATUS_PAGE_THEME,
			appearance: "dark",
			accent: "#aabbcc",
			background: "#0b0b0b",
		})
	})

	it("blocks a bad hex and unreadable text, but not overrides Auto ignores", () => {
		expect(hasSettingsIssues({ ...saved, theme: { ...saved.theme, card: "teal" } })).toBe(true)
		const lowContrast = { ...saved.theme, text: "#777777", background: "#ffffff" }
		expect(hasSettingsIssues({ ...saved, theme: { ...lowContrast, appearance: "light" } })).toBe(true)
		expect(hasSettingsIssues({ ...saved, theme: lowContrast })).toBe(false)
	})
})

describe("times the API would refuse as in the future", () => {
	const nowMs = Date.UTC(2026, 9, 1, 12)

	it("refuses an incident started after now, but not one started this minute or a maintenance window", () => {
		const incident = emptyIncidentForm("incident")
		expect(incidentIssues({ ...incident, startedAt: "2026-10-01T12:01" }, "UTC", nowMs).started).toBe(
			"It can't start in the future.",
		)
		expect(
			incidentIssues({ ...incident, startedAt: "2026-10-01T12:00" }, "UTC", nowMs).started,
		).toBeNull()
		expect(incidentIssues({ ...incident, startedAt: "" }, "UTC", nowMs).started).toBeNull()
		const maintenance = {
			...emptyIncidentForm("maintenance"),
			scheduledStart: "2026-10-02T09:00",
			scheduledEnd: "2026-10-02T10:00",
		}
		expect(incidentIssues(maintenance, "UTC", nowMs).window).toBeNull()
	})

	it("reads the typed time in the viewer's zone", () => {
		// 13:30 in Berlin is 11:30 UTC, before 12:00 UTC.
		const form = { ...emptyIncidentForm("incident"), startedAt: "2026-10-01T13:30" }
		expect(incidentIssues(form, "Europe/Berlin", nowMs).started).toBeNull()
		expect(incidentIssues(form, "UTC", nowMs).started).toBe("It can't start in the future.")
	})

	it("refuses a closing update that ended after now", () => {
		const resolving = updateFormFor({ id: incidentId(1), kind: "incident", status: "identified" }, true)
		const startedAt = "2026-10-01T11:00:00.000Z"
		expect(endedIssue({ ...resolving, endedAt: "2026-10-01T12:30" }, startedAt, "UTC", nowMs)).toBe(
			"It can't end in the future.",
		)
		expect(endedIssue({ ...resolving, endedAt: "2026-10-01T11:30" }, startedAt, "UTC", nowMs)).toBeNull()
	})

	it("refuses an edited incident start or end after now, but leaves a maintenance window to the API", () => {
		const edit = {
			incidentId: incidentId(1),
			kind: "incident" as const,
			status: "resolved" as const,
			title: "Elevated errors",
			impact: "minor" as const,
			componentIds: [],
			start: "2026-10-01T11:00",
			end: "2026-10-01T11:30",
		}
		expect(incidentEditIssues(edit, "UTC", nowMs).times).toBeNull()
		expect(incidentEditIssues({ ...edit, start: "2026-10-01T12:05" }, "UTC", nowMs).times).toBe(
			"It can't start in the future.",
		)
		expect(incidentEditIssues({ ...edit, end: "2026-10-01T12:05" }, "UTC", nowMs).times).toBe(
			"It can't end in the future.",
		)
		const window = {
			...edit,
			kind: "maintenance" as const,
			status: "scheduled" as const,
			start: "2026-10-02T09:00",
			end: "2026-10-02T10:00",
		}
		expect(incidentEditIssues(window, "UTC", nowMs).times).toBeNull()
	})
})
