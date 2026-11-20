import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { FleetIntegrationStatus } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Field from "@maple/views/ui/field"
import { AppRoute, hrefOf } from "../../../route"
import { PageOutMessage, type PageContext } from "../../contract"
import { cardStatusOf } from "../derive"
import { Message } from "../message"
import type { Model } from "../model"
import { init, update } from "../update"
import { view as pageView } from "../view"
import { FleetMessage } from "./fleet"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const fleet = (message: FleetMessage) => Message.GotFleetMessage({ message })
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const steps = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const NOW = Date.UTC(2026, 10, 20, 12)

const statusOf = (overrides: Partial<typeof FleetIntegrationStatus.Encoded> = {}) =>
	Schema.decodeSync(FleetIntegrationStatus)({
		connected: true,
		baseUrl: "https://fleet.acme.dev",
		organizationName: "Acme",
		apiUserName: "Maple",
		apiUserRole: "observer",
		serverVersion: "4.62.1",
		licenseTier: "premium",
		connectedByUserId: null,
		connectedAt: NOW - 86_400_000,
		authFailed: false,
		lastSyncedAt: NOW - 300_000,
		lastError: null,
		...overrides,
	})

const DISCONNECTED = statusOf({
	connected: false,
	baseUrl: null,
	organizationName: null,
	apiUserName: null,
	apiUserRole: null,
	serverVersion: null,
	licenseTier: null,
	connectedAt: null,
	lastSyncedAt: null,
})

/** The Fleet page with its status answered. */
const withFleet = (status: FleetIntegrationStatus, grants?: ReturnType<typeof Policy.grantsOf>): Model => {
	const model = init({ search: { integration: "fleet" } }, context).model
	return steps(model, [
		Message.CompletedReadClock({ nowMs: NOW }),
		...(grants === undefined ? [] : [Message.CompletedLoadSession({ grants, hasDataSources: false })]),
		Message.CompletedLoadFleet({ key: model.statuses.fleet.key ?? "", result: Result.succeed(status) }),
	])
}

const typed = (model: Model, url: string, token: string): Model =>
	steps(model, [
		fleet(FleetMessage.GotUrlMessage({ message: Field.Message.ChangedValue({ value: url }) })),
		fleet(FleetMessage.GotTokenMessage({ message: Field.Message.ChangedValue({ value: token }) })),
	])

describe("fleet card", () => {
	test("the page reads the Fleet status and the hub lists Fleet", () => {
		const entered = init({ search: { integration: "fleet" } }, context)
		expect(names(entered.commands)).toContain("LoadIntegrationsFleetStatus")
		scene(
			{ update: pageUpdate, view },
			given(withFleet(DISCONNECTED)),
			expectView(text("Connect Fleet")).toExist(),
			expectView(role("textbox", { name: "Fleet URL" })).toExist(),
		)
	})

	test("connecting sends the URL and token once, then toasts and re-reads the status", () => {
		const filled = typed(withFleet(DISCONNECTED), " https://fleet.acme.dev ", "fleet_token_0001")
		const sent = pageUpdate(filled, fleet(FleetMessage.SubmittedConnect()))
		expect(names(sent.commands)).toEqual(["ConnectFleetFromIntegrations"])
		expect(sent.model.fleetCard.form.isSubmitting).toBe(true)
		expect(names(pageUpdate(sent.model, fleet(FleetMessage.SubmittedConnect())).commands)).toEqual([])
		const done = pageUpdate(
			sent.model,
			fleet(FleetMessage.SucceededConnect({ title: "Fleet connected", description: "d" })),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Fleet connected", description: "d" }),
		)
		expect(names(done.commands)).toEqual(["LoadIntegrationsFleetStatus"])
		expect(done.model.fleetCard.form.token.value).toBe("")
	})

	test("an incomplete form is never sent", () => {
		const noToken = typed(withFleet(DISCONNECTED), "https://fleet.acme.dev", "")
		expect(names(pageUpdate(noToken, fleet(FleetMessage.SubmittedConnect())).commands)).toEqual([])
	})

	test("the server's validation message shows under the form", () => {
		const sent = pageUpdate(
			typed(withFleet(DISCONNECTED), "https://fleet.acme.dev", "fleet_token_0001"),
			fleet(FleetMessage.SubmittedConnect()),
		).model
		const rejected = steps(sent, [
			fleet(FleetMessage.FailedConnect({ error: "Fleet rejected the API token." })),
		])
		scene(
			{ update: pageUpdate, view },
			given(rejected),
			expectView(role("alert")).toHaveText("Fleet rejected the API token."),
			expectView(role("textbox", { name: "Fleet URL" })).toHaveValue("https://fleet.acme.dev"),
		)
	})

	test("connected shows the server, its user and sync state", () => {
		const model = withFleet(statusOf())
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Acme")).toExist(),
			expectView(text("4.62.1")).toExist(),
			expectView(text("Premium")).toExist(),
			expectView(role("button", { name: "Update token" })).toExist(),
			expectView(role("button", { name: "Disconnect" })).toExist(),
			// What Fleet feeds: device findings in Security and admin activity in the audit log.
			expectView(role("link", { name: "Security, Devices" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.SecurityDevices()),
			),
			expectView(role("link", { name: "audit log" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.SecurityAuditLog({ search: { provider: "fleet" } })),
			),
		)
		expect(cardStatusOf(model.statuses, "fleet", NOW)).toEqual({ label: "Connected", variant: "ok" })
	})

	test("an admin token gets the Observer note", () => {
		scene(
			{ update: pageUpdate, view },
			given(withFleet(statusOf({ apiUserRole: "admin" }))),
			expectView(
				text(
					"This token's user has the admin role. Maple only reads, so an API-only user with the Observer role is enough.",
				),
			).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withFleet(statusOf({ apiUserRole: "observer_plus" }))),
			expectView(text("This token's user has the observer_plus role.", { exact: false })).toExist(),
		)
	})

	test("a rejected token shows the form with the saved URL", () => {
		const model = withFleet(statusOf({ authFailed: true }))
		expect(model.fleetCard.form.url.value).toBe("https://fleet.acme.dev")
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("button", { name: "Update token" })).toExist(),
			expectView(role("textbox", { name: "Fleet URL" })).toHaveValue("https://fleet.acme.dev"),
			// A server that can no longer issue a token must still be removable.
			expectView(role("button", { name: "Disconnect" })).toExist(),
		)
		expect(cardStatusOf(model.statuses, "fleet", NOW)).toEqual({
			label: "Token rejected",
			variant: "crit",
		})
	})

	test("a member sees the status but no form or buttons", () => {
		const member = Policy.grantsOf(["org:member"])
		scene(
			{ update: pageUpdate, view },
			given(withFleet(statusOf(), member)),
			expectView(text("Acme")).toExist(),
			expectView(role("button", { name: "Disconnect" })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withFleet(DISCONNECTED, member)),
			expectView(role("textbox", { name: "Fleet URL" })).not.toExist(),
		)
		const filled = typed(withFleet(DISCONNECTED, member), "https://fleet.acme.dev", "fleet_token_0001")
		expect(names(pageUpdate(filled, fleet(FleetMessage.SubmittedConnect())).commands)).toEqual([])
	})

	test("disconnect runs the shared dialog, then toasts and re-reads the Fleet status", () => {
		const opened = pageUpdate(withFleet(statusOf()), Message.ClickedDisconnect()).model
		const confirmed = pageUpdate(opened, Message.ConfirmedDisconnect())
		expect(names(confirmed.commands)).toContain("DisconnectIntegration")
		const done = pageUpdate(
			confirmed.model,
			Message.CompletedDisconnect({ integration: "fleet", failure: null }),
		)
		expect(done.model.disconnect.dialog.isOpen).toBe(false)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Fleet disconnected", description: "" }),
		)
		expect(names(done.commands)).toContain("LoadIntegrationsFleetStatus")
	})
})
