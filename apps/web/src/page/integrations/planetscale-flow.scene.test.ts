import { OrgId } from "@maple/domain"
import {
	encodePublicId,
	PublicIdPrefixes,
	V2PlanetScaleIntegration,
	V2PlanetScaleOrganizationList,
} from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { click, Command, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import * as Field from "../../ui/field"
import type { PageContext } from "../contract"
import { ScrollToTop } from "../sources/new/command"
import { Message } from "../sources/new/message"
import type { Model } from "../sources/new/model"
import { init, update } from "../sources/new/update"
import { view as pageView } from "../sources/new/view"
import { Message as IntegrationMessage } from "./message"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const NOW = Date.parse("2026-10-24T12:00:00Z")

const send = (model: Model, message: IntegrationMessage) =>
	pageUpdate(model, Message.GotIntegrationsMessage({ message }))

const status = (over: Record<string, unknown> = {}) =>
	Schema.decodeUnknownSync(V2PlanetScaleIntegration)({
		object: "planetscale_integration",
		connected: true,
		pending_org_selection: false,
		organization: "acme",
		connected_by_user_id: null,
		detected_permissions: null,
		metrics_auth: "api",
		api_metrics: { last_polled_at: null, last_error: null },
		scrape_target: null,
		last_inventory_at: "2026-10-24T11:58:00Z",
		last_inventory_error: null,
		revoked_at: null,
		expires_at: null,
		...over,
	})

const organizations = Schema.decodeUnknownSync(V2PlanetScaleOrganizationList)({
	object: "planetscale_integration.organization_list",
	organizations: [
		{ id: "organization/acme", name: "acme" },
		{ id: "organization/labs", name: "labs" },
	],
})

/** `/sources/new?integration=planetscale` with the status loaded and the clock read. */
const entered = (loaded: V2PlanetScaleIntegration) => {
	const model = init({ _tag: "SourcesNew", search: { integration: "planetscale" } }, context).model
	const clocked = send(model, IntegrationMessage.CompletedReadClock({ nowMs: NOW })).model
	return send(
		clocked,
		IntegrationMessage.CompletedLoadPlanetscale({
			key: clocked.integrations.statuses.planetscale.key ?? "",
			result: Result.succeed(loaded),
		}),
	)
}

const withOrganizations = (model: Model) =>
	send(
		model,
		IntegrationMessage.CompletedFetchOrganizations({
			key: model.integrations.planetscaleCard.organizations.key ?? "",
			result: Result.succeed(organizations),
		}),
	).model

const notConnected = status({
	connected: false,
	organization: null,
	api_metrics: { last_polled_at: null, last_error: null },
	last_inventory_at: null,
})

describe("PlanetScale connect flow", () => {
	test("Connect offers the OAuth window and keeps Continue locked until PlanetScale approves", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered(notConnected).model),
			expectView(role("listitem", { current: "step", name: "Connect" })).toExist(),
			expectView(role("button", { name: "Continue with PlanetScale" })).toExist(),
			expectView(text(/Not authorized yet/)).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("a grant without read_databases blocks Connect and asks to reconnect with it", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered(status({ detected_permissions: { readDatabases: false } })).model),
			expectView(role("button", { name: "Reconnect with read_databases" })).toExist(),
			expectView(text(/cannot read databases/)).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("a grant over several organizations moves to Choose data, where one is picked and saved", () => {
		const pending = entered(status({ connected: false, pending_org_selection: true, organization: null }))
		expect(names(pending.commands)).toContain("FetchPlanetscaleOrganizations")
		const listed = withOrganizations(pending.model)
		scene(
			{ update: pageUpdate, view },
			given(listed),
			expectView(text(/pick one on the next step/)).toExist(),
			click(role("button", { name: "Continue" })),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			expectView(role("listitem", { current: "step", name: "Choose data" })).toExist(),
			expectView(role("listitem", { name: "Authorized" })).toExist(),
			expectView(role("radio", { name: "labs" })).toExist(),
			expectView(role("button", { name: "Start collecting" })).toBeDisabled(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
		const picked = send(listed, IntegrationMessage.SelectedOrganization({ name: "labs" })).model
		const saved = send(picked, IntegrationMessage.SubmittedOrganization())
		expect(names(saved.commands)).toEqual(["SelectPlanetscaleOrganization"])
	})

	test("a bound organization seeds Choose data, and an unsaved branch filter locks Continue", () => {
		const bound = entered(
			status({
				scrape_target: {
					id: encodePublicId(PublicIdPrefixes.scrapeTarget, "11111111-1111-4111-8111-111111111111"),
					object: "planetscale_integration.scrape_target",
					enabled: false,
					scrape_interval_seconds: 60,
					include_branches: [],
					exclude_branches: ["pr-*"],
					last_scrape_at: null,
					last_scrape_error: null,
				},
			}),
		).model
		const choosing = pageUpdate(bound, Message.ClickedContinue()).model
		scene(
			{ update: pageUpdate, view },
			given(choosing),
			expectView(role("listitem", { name: "acme" })).toExist(),
			expectView(role("listitem", { current: "step", name: "Choose data" })).toExist(),
			expectView(role("button", { name: "Continue" })).toBeEnabled(),
		)
		const edited = send(
			choosing,
			IntegrationMessage.GotBranchFieldMessage({
				field: "exclude",
				message: Field.Message.ChangedValue({ value: "pr-*, preview-*" }),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(edited),
			expectView(text("Save to apply the selection.")).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("a service token is checked by PlanetScale, and a rejection says nothing was saved", () => {
		const connected = entered(status()).model
		const chosen = send(
			connected,
			IntegrationMessage.SelectedPlanetscaleMetricsMethod({ method: "service_token" }),
		).model
		const filled = [
			IntegrationMessage.GotPlanetscaleTokenField({
				field: "id",
				message: Field.Message.ChangedValue({ value: "tok_1" }),
			}),
			IntegrationMessage.GotPlanetscaleTokenField({
				field: "secret",
				message: Field.Message.ChangedValue({ value: "pscale_tkn_x" }),
			}),
		].reduce((model, message) => send(model, message).model, chosen)
		scene(
			{ update: pageUpdate, view },
			given(filled),
			expectView(role("button", { name: /^Service token/ })).toHaveAttr("aria-pressed", "true"),
			expectView(role("button", { name: "Check and save token" })).toBeEnabled(),
		)
		const sent = send(filled, IntegrationMessage.SubmittedPlanetscaleToken())
		expect(names(sent.commands)).toEqual(["SetPlanetscaleMetricsToken"])
		const rejected = send(
			sent.model,
			IntegrationMessage.CompletedPlanetscaleToken({
				failure: toLoadFailure(new Error("401 Unauthorized.")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(rejected),
			expectView(text(/PlanetScale rejected this token: .*Nothing was saved/)).toExist(),
			expectView(role("button", { name: "Check token again" })).toExist(),
		)
	})

	test("Go live checks access, resources and the first poll, and flags a failed poll", () => {
		const live = (loaded: V2PlanetScaleIntegration) =>
			[Message.ClickedContinue(), Message.ClickedContinue()].reduce(
				(model, message) => pageUpdate(model, message).model,
				entered(loaded).model,
			)
		scene(
			{ update: pageUpdate, view },
			given(live(status())),
			expectView(role("listitem", { current: "step", name: "Go live" })).toExist(),
			expectView(text("Access works")).toExist(),
			expectView(text("Resources found")).toExist(),
			expectView(text("First poll, branch metrics")).toExist(),
			expectView(text("Step 3 of 3")).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				live(
					status({ api_metrics: { last_polled_at: null, last_error: "PlanetScale returned 403" } }),
				),
			),
			expectView(role("listitem", { current: "step", name: "Go live: needs attention" })).toExist(),
			expectView(text("The last poll failed: PlanetScale returned 403")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				live(status({ api_metrics: { last_polled_at: "2026-10-24T11:57:00Z", last_error: null } })),
			),
			expectView(role("listitem", { name: "Live" })).toExist(),
			expectView(text("PlanetScale is live")).toExist(),
		)
	})
})
