import { describe, expect, it } from "vitest"
import { GearIcon, ServerIcon, type IconComponent } from "@/components/icons"
import {
	DEFAULT_SETTINGS_TAB_ORDER,
	legacySettingsTabValues,
	resolveActiveSettingsTab,
	resolveLegacySettingsTab,
	settingsTabValues,
	type SettingsTab,
} from "./settings-nav"

const item = (id: SettingsTab, icon: IconComponent = GearIcon) => ({ id, label: id, icon })

/** General, Members and Billing are Clerk-gated, so self-hosted drops them. */
const SELF_HOSTED = [
	item("ingestion", ServerIcon),
	item("data-platform"),
	item("setup-health"),
	item("automation"),
	item("keys"),
	item("mcp"),
]

const CLERK = [
	item("general"),
	item("members"),
	item("billing"),
	item("ingestion", ServerIcon),
	item("setup-health"),
	item("keys"),
]

describe("resolveActiveSettingsTab", () => {
	it("honours an explicitly requested tab that is visible", () => {
		expect(resolveActiveSettingsTab("keys", CLERK)).toBe("keys")
		expect(resolveActiveSettingsTab("setup-health", SELF_HOSTED)).toBe("setup-health")
	})

	it("ignores a requested tab the current account cannot see", () => {
		expect(resolveActiveSettingsTab("billing", SELF_HOSTED)).toBe("ingestion")
	})

	it("ignores an unknown tab value", () => {
		expect(resolveActiveSettingsTab("nonsense", CLERK)).toBe("general")
	})

	it("lands on General for a Clerk workspace", () => {
		expect(resolveActiveSettingsTab(undefined, CLERK)).toBe("general")
	})

	it("lands on Ingestion when self-hosted, never on Setup health", () => {
		// `setup-health` is not Clerk-gated, so it survives into self-hosted mode and a positional
		// default could land on it (which would run the audit's warehouse reads on every visit
		// to Settings). Ordering the nav must never be able to make that happen.
		expect(resolveActiveSettingsTab(undefined, SELF_HOSTED)).toBe("ingestion")
	})

	it("falls back to the first visible item when no preferred default is available", () => {
		expect(resolveActiveSettingsTab(undefined, [item("mcp"), item("keys")])).toBe("mcp")
	})

	it("falls back to ingestion when nothing is visible at all", () => {
		expect(resolveActiveSettingsTab(undefined, [])).toBe("ingestion")
	})
})

describe("DEFAULT_SETTINGS_TAB_ORDER", () => {
	it("only lists real tabs", () => {
		for (const tab of DEFAULT_SETTINGS_TAB_ORDER) {
			expect(settingsTabValues).toContain(tab)
		}
	})

	it("never lands users on a tab that does expensive work on mount", () => {
		// `setup-health` issues a dozen warehouse reads (two of them cross-span joins) when its
		// section mounts. It must stay an explicit navigation, never a default.
		expect(DEFAULT_SETTINGS_TAB_ORDER).not.toContain("setup-health")
	})
})

describe("resolveLegacySettingsTab", () => {
	it("sends renamed tabs to their new ids", () => {
		expect(resolveLegacySettingsTab("organization")).toEqual({ kind: "tab", tab: "general" })
		expect(resolveLegacySettingsTab("api-keys")).toEqual({ kind: "tab", tab: "keys" })
		expect(resolveLegacySettingsTab("ai-provider")).toEqual({ kind: "tab", tab: "ai" })
		expect(resolveLegacySettingsTab("setup-audit")).toEqual({ kind: "tab", tab: "setup-health" })
		expect(resolveLegacySettingsTab("developer")).toEqual({ kind: "tab", tab: "keys" })
		expect(resolveLegacySettingsTab("escalations")).toEqual({ kind: "tab", tab: "automation" })
	})

	it("sends tabs that left Settings to their new page", () => {
		expect(resolveLegacySettingsTab("notifications")).toEqual({
			kind: "account",
			tab: "email-preferences",
		})
		expect(resolveLegacySettingsTab("connectors")).toEqual({ kind: "integrations" })
		expect(resolveLegacySettingsTab("integrations")).toEqual({ kind: "integrations" })
	})

	it("leaves current and unknown tab values alone", () => {
		for (const tab of settingsTabValues) {
			expect(resolveLegacySettingsTab(tab)).toBeUndefined()
		}
		expect(resolveLegacySettingsTab("nonsense")).toBeUndefined()
		expect(resolveLegacySettingsTab(undefined)).toBeUndefined()
	})

	it("never shadows a current tab id with a legacy one", () => {
		// A value in both unions would redirect away from a live tab forever.
		for (const legacy of legacySettingsTabValues) {
			expect(settingsTabValues).not.toContain(legacy)
		}
	})

	it("only redirects to tabs that exist", () => {
		const targets = legacySettingsTabValues.flatMap((legacy) => {
			const target = resolveLegacySettingsTab(legacy)
			return target?.kind === "tab" ? [target.tab] : []
		})
		expect(targets.length).toBeGreaterThan(0)
		expect(targets.filter((tab) => !settingsTabValues.includes(tab))).toEqual([])
	})
})
