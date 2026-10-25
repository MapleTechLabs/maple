import { Option } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, test } from "vitest"
import { init } from "../main"
import { Message } from "../message"
import type { Model } from "../model"
import { PageOutMessage } from "../page/contract"
import { PageMessage } from "../page/registry"
import * as Traces from "../page/traces"
import { update } from "../update"
import { foldPageOut } from "../update-page"

const flags = {
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	rememberedRange: "1h",
	isSidebarOpen: true,
	isMobile: true,
	theme: "dark" as const,
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	hasSavedResults: false,
}
const urlOf = (hash: string) => Option.getOrThrow(fromString(`http://localhost/#${hash}`))
const mobile = (): Model => init(flags, urlOf("/traces")).model
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

describe("mobile sidebar", () => {
	test("the trigger opens and closes the sheet without touching the saved rail state", () => {
		const opened = update(mobile(), Message.ClickedToggleSidebar())
		expect(opened.model.isSidebarOpenMobile).toBe(true)
		expect(opened.model.isSidebarOpen).toBe(true)
		expect(names(opened.commands)).toEqual([])
		expect(update(opened.model, Message.ClickedToggleSidebar()).model.isSidebarOpenMobile).toBe(false)
	})

	test("the backdrop and growing past md both close the sheet", () => {
		const opened = update(mobile(), Message.ClickedToggleSidebar()).model
		expect(update(opened, Message.DismissedMobileNav()).model.isSidebarOpenMobile).toBe(false)
		const desktop = update(opened, Message.ChangedViewport({ isMobile: false })).model
		expect(desktop.isSidebarOpenMobile).toBe(false)
		expect(update(desktop, Message.ClickedToggleSidebar()).model.isSidebarOpen).toBe(false)
	})
})

describe("filters drawer", () => {
	test("the page's Filters button opens it through the root", () => {
		const step = update(
			mobile(),
			Message.GotPageMessage({ message: PageMessage.GotTracesMessage({ message: Traces.Message.ClickedOpenFilters() }) }),
		)
		expect(step.model.filterDrawer.isOpen).toBe(true)
	})

	test("a filter change on the same page keeps it open; another page starts it closed", () => {
		const opened = foldPageOut(mobile(), PageOutMessage.RequestedFilterDrawer()).model
		const refiltered = update(opened, Message.ChangedUrl({ url: urlOf("/traces?service=storefront") })).model
		expect(refiltered.filterDrawer.isOpen).toBe(true)
		const elsewhere = update(refiltered, Message.ChangedUrl({ url: urlOf("/logs") })).model
		expect(elsewhere.filterDrawer.isOpen).toBe(false)
	})
})
