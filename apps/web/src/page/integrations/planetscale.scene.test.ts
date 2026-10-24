import { OrgId } from "@maple/domain"
import { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const pending = Schema.decodeUnknownSync(V2PlanetScaleIntegration)({
	object: "planetscale_integration",
	connected: false,
	pending_org_selection: true,
	organization: null,
	connected_by_user_id: null,
	detected_permissions: null,
	metrics_auth: "api",
	scrape_target: null,
	last_inventory_at: null,
	last_inventory_error: null,
	revoked_at: null,
	expires_at: null,
})

const withPending = () => {
	const model = init({ search: { integration: "planetscale" } }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadPlanetscale({
			key: model.statuses.planetscale.key ?? "",
			result: Result.succeed(pending),
		}),
	)
}

describe("planetscale card", () => {
	test("an organization still to be picked sends the source page back to the connect flow", () => {
		const entered = withPending()
		expect(names(entered.commands)).toEqual(["FetchPlanetscaleOrganizations"])
		scene(
			{ update: pageUpdate, view },
			given(entered.model),
			expectView(text(/no organization is picked yet/)).toExist(),
			expectView(role("link", { name: "Reconnect" })).toHaveAttr(
				"href",
				"/sources/new?integration=planetscale",
			),
		)
	})

	test("connecting an organization sends it once and toasts its name", () => {
		const picked = pageUpdate(withPending().model, Message.SelectedOrganization({ name: "labs" })).model
		const sent = pageUpdate(picked, Message.SubmittedOrganization())
		expect(names(sent.commands)).toEqual(["SelectPlanetscaleOrganization"])
		expect(names(pageUpdate(sent.model, Message.SubmittedOrganization()).commands)).toEqual([])
		const done = pageUpdate(
			sent.model,
			Message.CompletedSelectOrganization({ organization: "labs", failure: null }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "PlanetScale organization labs connected",
				description: "",
			}),
		)
	})

	test("the webhook row reports registration and offers to reconnect when the grant predates webhooks", () => {
		const connected = (webhooks: Record<string, unknown>) => {
			const model = init({ search: { integration: "planetscale" } }, context).model
			return pageUpdate(
				model,
				Message.CompletedLoadPlanetscale({
					key: model.statuses.planetscale.key ?? "",
					result: Result.succeed(
						Schema.decodeUnknownSync(V2PlanetScaleIntegration)({
							object: "planetscale_integration",
							connected: true,
							pending_org_selection: false,
							organization: "acme",
							connected_by_user_id: null,
							detected_permissions: null,
							metrics_auth: "service_token",
							scrape_target: null,
							webhooks: {
								registered_databases: 0,
								databases: 2,
								last_error: null,
								...webhooks,
							},
							last_inventory_at: null,
							last_inventory_error: null,
							revoked_at: null,
							expires_at: null,
						}),
					),
				}),
			).model
		}
		scene(
			{ update: pageUpdate, view },
			given(connected({ state: "needs_reauthorization" })),
			expectView(text("Needs attention")).toExist(),
			expectView(role("button", { name: "Reconnect" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				connected({ state: "failing", registered_databases: 1, last_error: "Webhook limit reached" }),
			),
			expectView(text("Webhook limit reached")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(connected({ state: "active", registered_databases: 2 })),
			expectView(text("Active")).toExist(),
			expectView(role("button", { name: "Reconnect" })).not.toExist(),
		)
	})

	test("metrics polled from the API wait for the first poll, then stream, and surface a poll error", () => {
		const NOW = Date.parse("2026-08-04T12:00:00Z")
		const connected = (apiMetrics: { last_polled_at: string | null; last_error: string | null }) => {
			const model = init({ search: { integration: "planetscale" } }, context).model
			const loaded = pageUpdate(
				model,
				Message.CompletedLoadPlanetscale({
					key: model.statuses.planetscale.key ?? "",
					result: Result.succeed(
						Schema.decodeUnknownSync(V2PlanetScaleIntegration)({
							object: "planetscale_integration",
							connected: true,
							pending_org_selection: false,
							organization: "acme",
							connected_by_user_id: null,
							detected_permissions: null,
							metrics_auth: "api",
							api_metrics: apiMetrics,
							scrape_target: null,
							last_inventory_at: null,
							last_inventory_error: null,
							revoked_at: null,
							expires_at: null,
						}),
					),
				}),
			).model
			return pageUpdate(loaded, Message.CompletedReadClock({ nowMs: NOW })).model
		}
		scene(
			{ update: pageUpdate, view },
			given(connected({ last_polled_at: null, last_error: null })),
			expectView(text("Starting")).toExist(),
			expectView(text("First poll, branch metrics")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(connected({ last_polled_at: new Date(NOW - 4 * 60_000).toISOString(), last_error: null })),
			expectView(text("Connected")).toExist(),
			expectView(text(/metrics API every 5 minutes/)).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(connected({ last_polled_at: null, last_error: "PlanetScale returned 403" })),
			expectView(text("Needs attention")).toExist(),
			expectView(text("The last poll failed: PlanetScale returned 403")).toExist(),
		)
	})
})
