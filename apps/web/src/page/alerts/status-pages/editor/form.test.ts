import { describe, expect, it } from "vitest"
import { isSameSettings, type SettingsForm } from "./form"

const saved: SettingsForm = {
	name: "Acme!",
	slug: "acme",
	description: "",
	websiteUrl: "https://acme.example",
	logoUrl: "",
	brandColor: "#aabbcc",
	showPoweredBy: true,
	autoIncidents: "off",
}

describe("isSameSettings", () => {
	it("treats a draft the API stored trimmed and lower-cased as saved", () => {
		const draft = { ...saved, name: "Acme! ", websiteUrl: " https://acme.example", brandColor: "#AABBCC" }
		expect(isSameSettings(draft, saved)).toBe(true)
	})

	it("still sees a real change", () => {
		expect(isSameSettings({ ...saved, brandColor: "#aabbcd" }, saved)).toBe(false)
	})
})
