import { DEFAULT_STATUS_PAGE_THEME } from "@maple/domain/status-page"
import { describe, expect, it } from "vitest"
import {
	hasSettingsIssues,
	isSameSettings,
	type SettingsForm,
	settingsIssues,
	settingsPayload,
	themeFormOf,
} from "./form"

const saved: SettingsForm = {
	name: "Acme!",
	slug: "acme",
	description: "",
	websiteUrl: "https://acme.example",
	privacyUrl: "",
	termsUrl: "",
	logoUrl: "",
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
