import { OrgId } from "@maple/domain"
import {
	DevicePolicyFinding,
	IntegrationsForbiddenError,
	IntegrationsPersistenceError,
} from "@maple/domain/http"
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
	allClearDevices,
	authFailedDevices,
	firstSyncDevices,
	freeDevices,
	notConnectedDevices,
	premiumDevices,
	syncErrorDevices,
	firstSyncFailedDevices,
	twoSourceDevices,
} from "../../../lab/security-devices-fixture"
import { AppRoute, hrefOf } from "../../../route"
import type { PageContext } from "../../contract"
import { FetchDevices, ReadDevicesClock } from "./command"
import { Devices, Message, type Model } from "./model"
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
	test("opening the page reads the clock, then the findings once, under the key it waits on", () => {
		const opened = init(route, context)
		const key = opened.model.devices.key ?? ""
		expect(key).not.toBe("")
		// Compared by name and arguments, taken from the commands themselves rather than spelled out.
		const requests = (commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }>) =>
			Arr.map(commands, ({ name, args }) => ({ name, args }))
		expect(requests(opened.commands ?? [])).toEqual(requests([ReadDevicesClock(), FetchDevices({ key })]))
	})

	test("an org with no device source is pointed at the Fleet integration card", () => {
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
			// One source: no source tag between the critical badge and the failing count.
			expectView(nth(all.role("row"), 1)).toContainText("Disk encryption enabledCritical7 of"),
		)
	})

	test("a policy opens to its failing devices, each linking to the device in Fleet", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(premiumDevices(NOW))),
			expectView(role("link", { name: "mbp-anna" })).toBeAbsent(),
			click(role("button", { name: /^Show failing devices: Disk encryption enabled, critical, 7 of/ })),
			expectView(role("link", { name: "mbp-anna" })).toHaveAttr(
				"href",
				"https://fleet.acme.dev/hosts/100",
			),
			expectView(text("Failing devices")).toExist(),
			expectView(role("link", { name: "Open the policy in Fleet" })).toHaveAttr(
				"href",
				"https://fleet.acme.dev/policies/12",
			),
			click(role("button", { name: /^Hide failing devices: Disk encryption enabled, critical, 7 of/ })),
			expectView(role("link", { name: "mbp-anna" })).toBeAbsent(),
		)
	})

	test("a policy with no sampled devices says Maple has no names, not that the source listed none", () => {
		const premium = premiumDevices(NOW)
		const unsampled = new Devices({
			...premium,
			policies: Arr.map(
				premium.policies,
				(policy) => new DevicePolicyFinding({ ...policy, failingDevices: [] }),
			),
		})
		scene(
			{ update: pageUpdate, view },
			given(loaded(unsampled)),
			click(role("button", { name: /^Show failing devices: Disk encryption enabled, critical, 7 of/ })),
			expectView(text("Maple has no device names for this policy. Fleet lists them.")).toExist(),
			expectView(text("Failing devices, 0 of 7")).toBeAbsent(),
		)
	})

	test("Fleet Free has no scores: no CVSS column, no known exploited tile, one line saying why", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(freeDevices(NOW))),
			// No account name: the brand links to the server.
			expectView(role("link", { name: "Fleet" })).toHaveAttr("href", "https://fleet.acme.dev"),
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

	test("with two sources each row names its source and each notice names the source it is about", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(twoSourceDevices(NOW))),
			expectView(role("link", { name: "Acme" })).toHaveAttr("href", "https://fleet.acme.dev"),
			expectView(role("link", { name: "Acme EU" })).toHaveAttr("href", "https://fleet-eu.acme.dev"),
			expectView(text("304")).toExist(),
			// Both servers are Fleet, so the tag is the account; the larger failing count leads.
			expectView(nth(all.role("row"), 1)).toContainText("Disk encryption enabled"),
			expectView(nth(all.role("row"), 1)).toContainText("CriticalAcme7 of"),
			// The EU source counts no passing devices, so its row gives the failing count alone.
			expectView(nth(all.role("row"), 2)).toContainText("CriticalAcme EU3 devices failing"),
			expectView(text("Fleet rejected the saved token for Acme EU")).toExist(),
			expectView(text("Fleet rejected the saved token for Acme")).toBeAbsent(),
			expectView(role("link", { name: "Save a new token" })).toHaveAttr("href", FLEET_CARD),
			// The rest past the 500 links to the source that has it, named by its account.
			expectView(role("link", { name: "+37 more in Acme" })).toHaveAttr(
				"href",
				"https://fleet.acme.dev/software/vulnerabilities",
			),
			expectView(role("link", { name: "+37 more in Fleet" })).toBeAbsent(),
		)
	})

	test("the same policy id on two sources opens only the one clicked", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(twoSourceDevices(NOW))),
			// Each row names its source, so the EU one is reachable by name alone.
			click(
				role("button", {
					name: /^Show failing devices: Disk encryption enabled, critical, Acme EU, 3 devices failing/,
				}),
			),
			expectView(role("link", { name: "Open the policy in Fleet" })).toHaveAttr(
				"href",
				"https://fleet-eu.acme.dev/policies/12",
			),
			expectView(
				role("button", {
					name: /^Show failing devices: Disk encryption enabled, critical, Acme, 7 of/,
				}),
			).toExist(),
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

	test("an all-clear says which policies the source reads", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(allClearDevices(NOW))),
			expectView(text("No failing policies")).toExist(),
			expectView(text("Team policies are not read yet.", { exact: false })).toExist(),
		)
	})

	test("a CVE links to its details page beside its page in the source", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(premiumDevices(NOW))),
			expectView(role("link", { name: "Details of CVE-2024-38063" })).toHaveAttr(
				"href",
				"https://nvd.nist.gov/vuln/detail/CVE-2024-38063",
			),
		)
	})

	test("a first sync that failed shows its error instead of waiting", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(firstSyncFailedDevices(NOW))),
			expectView(text("The first sync failed")).toExist(),
			expectView(text("Fleet answered 500.", { exact: false })).toExist(),
			expectView(text("Waiting for the first sync")).toBeAbsent(),
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
