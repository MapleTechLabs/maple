import { OrgId } from "@maple/domain"
import { SearchConsoleAvailableSitesResponse, SearchConsoleIntegrationStatus } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const status = (fields: {
	connected: boolean
	configured?: boolean
	enabled?: ReadonlyArray<string>
	lastError?: string
}) =>
	Schema.decodeSync(SearchConsoleIntegrationStatus)({
		configured: fields.configured ?? true,
		connected: fields.connected,
		accountEmail: fields.connected ? "owner@acme.dev" : null,
		connectedByUserId: null,
		revoked: false,
		sites: Arr.map(fields.enabled ?? [], (siteUrl, index) => ({
			id: `0190f2b3-0000-7000-8000-00000000000${index}`,
			siteUrl,
			permissionLevel: "siteOwner",
			enabled: true,
			watermarkDate: null,
			lastSyncedAt: null,
			lastError: fields.lastError ?? null,
		})),
	})

const SITES = Schema.decodeSync(SearchConsoleAvailableSitesResponse)({
	sites: [
		{
			siteUrl: "https://blog.acme.dev/",
			permissionLevel: "siteFullUser",
			selectable: true,
			enabled: false,
		},
		{ siteUrl: "sc-domain:acme.dev", permissionLevel: "siteOwner", selectable: true, enabled: true },
	],
})

const entered = (loaded: SearchConsoleIntegrationStatus) => {
	const model = init({ search: { integration: "google-search-console" } }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadSearchConsole({
			key: model.statuses.searchConsole.key ?? "",
			result: Result.succeed(loaded),
		}),
	)
}

const withSites = (loaded: SearchConsoleIntegrationStatus) => {
	const step = entered(loaded)
	return pageUpdate(
		step.model,
		Message.CompletedLoadSearchConsoleSites({
			key: step.model.searchConsoleCard.sites.key ?? "",
			result: Result.succeed(SITES),
		}),
	).model
}

describe("google search console card", () => {
	test("an unconnected org gets the connect button and no property read", () => {
		const step = entered(status({ connected: false }))
		expect(names(step.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			expectView(role("button", { name: "Connect Google" })).toExist(),
		)
	})

	test("a deployment without the OAuth client says so and cannot connect", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered(status({ connected: false, configured: false })).model),
			expectView(text(/not configured for this Maple deployment/)).toExist(),
		)
	})

	test("a connected org reads its properties and lists them with their saved choice", () => {
		const step = entered(status({ connected: true, enabled: ["sc-domain:acme.dev"] }))
		expect(names(step.commands)).toEqual(["FetchSearchConsoleSites"])
		scene(
			{ update: pageUpdate, view },
			given(withSites(status({ connected: true, enabled: ["sc-domain:acme.dev"] }))),
			expectView(role("checkbox", { name: "acme.dev (domain)" })).toBeChecked(),
			expectView(role("checkbox", { name: "https://blog.acme.dev/" })).not.toBeChecked(),
		)
	})

	test("saving sends the toggled selection once, then re-reads the status", () => {
		const loaded = withSites(status({ connected: true, enabled: ["sc-domain:acme.dev"] }))
		const toggled = pageUpdate(
			loaded,
			Message.ToggledSearchConsoleSite({ siteUrl: "https://blog.acme.dev/" }),
		).model
		expect(toggled.searchConsoleCard.draft).toEqual(["sc-domain:acme.dev", "https://blog.acme.dev/"])
		const saving = pageUpdate(toggled, Message.ClickedSaveSearchConsoleSites())
		expect(names(saving.commands)).toEqual(["SaveSearchConsoleSites"])
		expect(names(pageUpdate(saving.model, Message.ClickedSaveSearchConsoleSites()).commands)).toEqual([])
		const saved = pageUpdate(saving.model, Message.CompletedSaveSearchConsoleSites({ failure: null }))
		expect(names(saved.commands)).toEqual(["LoadIntegrationsSearchConsoleStatus"])
		// The draft holds until the re-read lands, so the checkboxes don't flick back meanwhile.
		scene(
			{ update: pageUpdate, view },
			given(saved.model),
			expectView(role("checkbox", { name: "https://blog.acme.dev/" })).toBeChecked(),
		)
		const reread = pageUpdate(
			saved.model,
			Message.CompletedLoadSearchConsole({
				key: saved.model.statuses.searchConsole.key ?? "",
				result: Result.succeed(
					status({ connected: true, enabled: ["sc-domain:acme.dev", "https://blog.acme.dev/"] }),
				),
			}),
		)
		expect(reread.model.searchConsoleCard.draft).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(reread.model),
			expectView(role("checkbox", { name: "https://blog.acme.dev/" })).toBeChecked(),
			expectView(role("checkbox", { name: "acme.dev (domain)" })).toBeChecked(),
		)
	})

	test("a saved property the account lost is dropped from the selection, named, and saved away", () => {
		const loaded = withSites(
			status({ connected: true, enabled: ["sc-domain:acme.dev", "sc-domain:gone.dev"] }),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			expectView(text(/saving stops importing gone\.dev \(domain\)/)).toExist(),
			expectView(role("button", { name: "Save properties" })).toBeEnabled(),
		)
		const saving = pageUpdate(loaded, Message.ClickedSaveSearchConsoleSites())
		expect(saving.commands?.[0]?.args).toEqual({ siteUrls: ["sc-domain:acme.dev"] })
	})

	test("a property whose import fails shows Google's error on its row", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				withSites(
					status({ connected: true, enabled: ["sc-domain:acme.dev"], lastError: "quota exceeded" }),
				),
			),
			expectView(text("Import failing: quota exceeded")).toExist(),
		)
	})
})
