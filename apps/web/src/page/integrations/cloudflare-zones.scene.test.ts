import * as Animation from "@foldkit/ui/animation"
import { OrgId } from "@maple/domain"
import { CloudflareIntegrationStatus, IntegrationsForbiddenError } from "@maple/domain/http"
import { Result, Schema } from "effect"
import {
	click,
	Command,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import { LoadCloudflare } from "./command"
import * as Dialog from "../../ui/dialog"
import type { PageContext } from "../contract"
import { SaveCloudflareZones } from "./cloudflare"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const NOW = Date.parse("2026-10-01T12:00:00Z")

const zone = (id: string, name: string, watched: boolean) => ({
	id,
	name,
	enabled: watched,
	lastSyncedAt: NOW - 60_000,
	lastError: null,
	watermarkAt: NOW - 60_000,
	backfillAt: null,
	watched,
})

const zones = [zone("z1", "acme.com", true), zone("z2", "staging.acme.com", false)]

const status = Schema.decodeUnknownSync(CloudflareIntegrationStatus)({
	connected: true,
	accountId: "acc_1",
	accountName: "Acme",
	connectedByUserId: null,
	scope: "analytics.read",
	analyticsCapable: true,
	connectedAt: NOW - 86_400_000,
	accounts: [
		{
			accountId: "acc_1",
			accountName: "Acme",
			connectedByUserId: null,
			scope: "analytics.read",
			analyticsCapable: true,
			revoked: false,
			zones,
			workers: null,
			watchNewZones: true,
		},
	],
	zones,
	workers: null,
})

const connected = (): Model => {
	const model = init({ search: { integration: "cloudflare" } }, context).model
	const clocked = pageUpdate(model, Message.CompletedReadClock({ nowMs: NOW })).model
	return pageUpdate(
		clocked,
		Message.CompletedLoadCloudflare({
			key: clocked.statuses.cloudflare.key ?? "",
			result: Result.succeed(status),
		}),
	).model
}

/** The portal Mount, then the enter transition's paint and settle. */
const opened = [
	Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
]

describe("cloudflare zone selection", () => {
	test("a zone the customer paused reads as paused by them", () => {
		scene(
			{ update: pageUpdate, view },
			given(connected()),
			expectView(text("Paused by you")).toExist(),
			expectView(role("button", { name: "Manage zones" })).toExist(),
		)
	})

	test("unchecking a zone and saving sends every zone of the account with its choice", () => {
		scene(
			{ update: pageUpdate, view },
			given(connected()),
			click(role("button", { name: "Manage zones" })),
			...opened,
			expectView(role("checkbox", { name: "staging.acme.com" })).toHaveAttr("aria-checked", "false"),
			click(role("checkbox", { name: "acme.com" })),
			click(role("button", { name: "Save zones" })),
			Command.expectHas(
				SaveCloudflareZones({
					accounts: [
						{
							accountId: "acc_1",
							accountName: "Acme",
							watchNewZones: true,
							zones: [
								{ id: "z1", name: "acme.com", watched: false },
								{ id: "z2", name: "staging.acme.com", watched: false },
							],
						},
					],
				}),
			),
			// A refused save keeps the draft open and says why.
			Command.resolve(
				SaveCloudflareZones,
				Message.CompletedCloudflareZones({
					failure: toLoadFailure(
						new IntegrationsForbiddenError({
							message: "Only org admins can manage integrations",
						}),
					),
				}),
			),
			// The status is re-read in case an earlier account landed; the draft survives it.
			Command.resolve(
				LoadCloudflare,
				Message.CompletedLoadCloudflare({
					key: connected().statuses.cloudflare.key ?? "",
					result: Result.succeed(status),
				}),
			),
			expectView(text("Only org admins can manage integrations")).toExist(),
			expectView(role("checkbox", { name: "acme.com" })).toHaveAttr("aria-checked", "false"),
		)
	})

	test("a saved choice closes the dialog and re-reads the status", () => {
		const step = (model: Model, message: Message) => pageUpdate(model, message).model
		const opened = step(connected(), Message.ClickedManageZones())
		const edited = step(opened, Message.ToggledManagedZone({ accountId: "acc_1", zoneId: "z1" }))
		const saving = step(edited, Message.SubmittedZoneSettings())
		expect(saving.cloudflareCard.isSavingZones).toBe(true)
		expect(saving.cloudflareCard.zoneDialog.isOpen).toBe(true)

		const saved = pageUpdate(saving, Message.CompletedCloudflareZones({ failure: null }))
		expect(saved.model.cloudflareCard.isSavingZones).toBe(false)
		expect(saved.model.cloudflareCard.zoneDialog.isOpen).toBe(false)
		expect((saved.commands ?? []).map(({ name }) => name)).toContain("LoadIntegrationsCloudflareStatus")
	})
})
