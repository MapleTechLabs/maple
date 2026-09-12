import { describe, expect, it } from "vitest"
import { GearIcon, ServerIcon, type IconComponent } from "@/components/icons"
import {
	DEFAULT_SETTINGS_TAB_ORDER,
	resolveActiveSettingsTab,
	settingsTabValues,
	type SettingsTab,
} from "./settings-nav"

const item = (id: SettingsTab, icon: IconComponent = GearIcon) => ({ id, label: id, icon })

/** Organization, Members, Billing and Notifications are Clerk-gated, so self-hosted drops them. */
const SELF_HOSTED = [
	item("ingestion", ServerIcon),
	item("data-platform"),
	item("setup-audit"),
	item("automation"),
	item("api-keys"),
	item("mcp"),
]

const CLERK = [
	item("organization"),
	item("members"),
	item("billing"),
	item("ingestion", ServerIcon),
	item("setup-audit"),
	item("api-keys"),
]

describe("resolveActiveSettingsTab", () => {
	it("honours an explicitly requested tab that is visible", () => {
		expect(resolveActiveSettingsTab("api-keys", CLERK)).toBe("api-keys")
		expect(resolveActiveSettingsTab("setup-audit", SELF_HOSTED)).toBe("setup-audit")
	})

	it("ignores a requested tab the current account cannot see", () => {
		expect(resolveActiveSettingsTab("billing", SELF_HOSTED)).toBe("ingestion")
	})

	it("ignores an unknown tab value", () => {
		expect(resolveActiveSettingsTab("nonsense", CLERK)).toBe("organization")
	})

	it("lands on Organization for a Clerk workspace", () => {
		expect(resolveActiveSettingsTab(undefined, CLERK)).toBe("organization")
	})

	it("lands on Ingestion when self-hosted, never on Setup Audit", () => {
		// `setup-audit` is not Clerk-gated, so it survives into self-hosted mode and a positional
		// default could land on it — which would run the audit's warehouse reads on every visit
		// to Settings. Ordering the nav must never be able to make that happen.
		expect(resolveActiveSettingsTab(undefined, SELF_HOSTED)).toBe("ingestion")
	})

	it("falls back to the first visible item when no preferred default is available", () => {
		expect(resolveActiveSettingsTab(undefined, [item("mcp"), item("api-keys")])).toBe("mcp")
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
		// `setup-audit` issues a dozen warehouse reads (two of them cross-span joins) when its
		// section mounts. It must stay an explicit navigation, never a default.
		expect(DEFAULT_SETTINGS_TAB_ORDER).not.toContain("setup-audit")
	})
})
