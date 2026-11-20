import { OrgId } from "@maple/domain"
import { IntegrationsForbiddenError, IntegrationsPersistenceError } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import {
	all,
	click,
	Command,
	expect as expectView,
	given,
	Mount,
	nth,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MountNetworkAutoRetry } from "@maple/views/ui/error-state"
import {
	authFailedDevices,
	firstSyncDevices,
	freeDevices,
	notConnectedDevices,
	premiumDevices,
	syncErrorDevices,
} from "../../../lab/security-devices-fixture"
import { AppRoute, hrefOf } from "../../../route"
import type { PageContext } from "../../contract"
import { FetchDevices, ReadDevicesClock } from "./command"
import { type Devices, Message, type Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 10, 20, 12, 0)
const route = AppRoute.SecurityDevices()
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const FLEET_CARD = hrefOf(AppRoute.Integrations({ search: { integration: "fleet" } }))

const answeredWith = (result: Result.Result<Devices, ReturnType<typeof toLoadFailure>>): Model =>
	Arr.reduce(
		[
			() => Message.ReadClock({ nowMs: NOW }),
			(model: Model) => Message.CompletedFetchDevices({ key: model.devices.key ?? "", result }),
		],
		init(route, context).model,
		(model, toMessage) => pageUpdate(model, toMessage(model)).model,
	)
const loaded = (devices: Devices) => answeredWith(Result.succeed(devices))

describe("security devices", () => {
	test("the page reads the Fleet devices once, with the clock", () => {
		expect(Arr.map(init(route, context).commands ?? [], ({ name }) => name)).toEqual(
			expect.arrayContaining(["SecurityApiFleetDevices", "ReadSecurityDevicesClock"]),
		)
	})

	test("an org without Fleet is pointed at the Fleet integration card", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(notConnectedDevices)),
			expectView(role("link", { name: "Connect Fleet" })).toHaveAttr("href", FLEET_CARD),
			expectView(role("table", { name: "Failing policies" })).toBeAbsent(),
		)
	})

	test("a server connected but not synced yet says the first sync is on its way", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(firstSyncDevices(NOW))),
			expectView(text("Waiting for the first sync")).toExist(),
			expectView(role("link", { name: "Acme" })).toHaveAttr("href", "https://fleet.acme.dev"),
			expectView(role("table", { name: "Vulnerabilities" })).toBeAbsent(),
		)
	})

	test("policies and CVEs list in the order Fleet ranks them, each linking into Fleet", () => {
		const devices = premiumDevices(NOW)
		scene(
			{ update: pageUpdate, view },
			given(loaded(devices)),
			expectView(role("link", { name: "Acme" })).toHaveAttr("href", "https://fleet.acme.dev"),
			// Row 0 is the policies' header; the critical policy leads.
			expectView(nth(all.role("row"), 1)).toContainText("Disk encryption enabled"),
			expectView(nth(all.role("row"), 1)).toContainText("Critical"),
			expectView(nth(all.role("row"), 2)).toContainText("Operating system is up to date"),
			expectView(text("7 of 236 devices failing")).toExist(),
			expectView(role("link", { name: "CVE-2024-38063" })).toHaveAttr(
				"href",
				"https://fleet.acme.dev/software/vulnerabilities/CVE-2024-38063",
			),
			// After the 4 policies and the CVE header: highest CVSS first, then the known exploited one.
			expectView(nth(all.role("row"), 6)).toContainText("CVE-2024-38063"),
			expectView(nth(all.role("row"), 7)).toContainText("CVE-2024-7971"),
			expectView(nth(all.role("row"), 7)).toContainText("Known exploited"),
			expectView(role("link", { name: "+37 more in Fleet" })).toHaveAttr(
				"href",
				"https://fleet.acme.dev/software/vulnerabilities",
			),
			expectView(text("Known exploited")).toExist(),
		)
	})

	test("a policy opens to its failing devices, each linking to the device in Fleet", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(premiumDevices(NOW))),
			expectView(role("link", { name: "mbp-anna" })).toBeAbsent(),
			click(role("button", { name: "Show failing devices: Disk encryption enabled" })),
			expectView(role("link", { name: "mbp-anna" })).toHaveAttr(
				"href",
				"https://fleet.acme.dev/hosts/100",
			),
			expectView(text("Failing devices")).toExist(),
			expectView(role("link", { name: "Open the policy in Fleet" })).toHaveAttr(
				"href",
				"https://fleet.acme.dev/policies/12",
			),
			click(role("button", { name: "Hide failing devices: Disk encryption enabled" })),
			expectView(role("link", { name: "mbp-anna" })).toBeAbsent(),
		)
	})

	test("Fleet Free has no scores: no CVSS column, no known exploited tile, one line saying why", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(freeDevices(NOW))),
			expectView(role("table", { name: "Vulnerabilities" })).toExist(),
			expectView(role("columnheader", { name: "CVSS" })).toBeAbsent(),
			expectView(text("Known exploited")).toBeAbsent(),
			expectView(
				text("CVSS scores and known exploited flags need Fleet Premium", { exact: false }),
			).toExist(),
		)
	})

	test("a rejected token says syncing is paused and links to saving a new one, over the last findings", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(authFailedDevices(NOW))),
			expectView(text("Fleet rejected the saved token")).toExist(),
			expectView(role("link", { name: "Save a new token" })).toHaveAttr("href", FLEET_CARD),
			expectView(role("table", { name: "Failing policies" })).toExist(),
		)
	})

	test("a failed sync shows its error and keeps the last findings", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(syncErrorDevices(NOW))),
			expectView(text("The last sync failed")).toExist(),
			expectView(text("Fleet did not answer within 30 seconds.", { exact: false })).toExist(),
			expectView(role("table", { name: "Vulnerabilities" })).toExist(),
		)
	})

	test("a viewer without security access is told who can open it, not shown an error", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				answeredWith(
					Result.fail(
						toLoadFailure(new IntegrationsForbiddenError({ message: "Missing security:manage" })),
					),
				),
			),
			expectView(text("Security is visible to org admins and engineers only")).toExist(),
			expectView(role("button", { name: "Retry" })).toBeAbsent(),
		)
	})

	test("a failed read is an error that retries into the findings", () => {
		const failed = answeredWith(
			Result.fail(toLoadFailure(new IntegrationsPersistenceError({ message: "Database unavailable" }))),
		)
		// A retry supersedes the failed read, so it asks under a new key.
		const key = pageUpdate(failed, Message.ClickedRetry()).model.devices.key ?? ""
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load device findings")).toExist(),
			Mount.resolve(
				MountNetworkAutoRetry({ retryKey: JSON.stringify(Message.ClickedRetry()) }),
				Message.ClickedRetry(),
			),
			Command.resolve(ReadDevicesClock(), Message.ReadClock({ nowMs: NOW })),
			Command.resolve(
				FetchDevices({ key }),
				Message.CompletedFetchDevices({ key, result: Result.succeed(premiumDevices(NOW)) }),
			),
			Mount.expectEnded(MountNetworkAutoRetry),
			expectView(role("table", { name: "Failing policies" })).toExist(),
		)
	})
})
