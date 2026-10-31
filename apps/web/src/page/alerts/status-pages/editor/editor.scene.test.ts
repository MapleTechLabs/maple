import { OrgId } from "@maple/domain"
import { StatusPagePublicId, type V2StatusPage } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import {
	click,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	selector,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import { PageOutMessage, type PageContext } from "../../../contract"
import { statusPagesTabHref } from "../../shared/status-page-commands"
import { ORG } from "../../shared/test-rows"
import { downMonitor, httpMonitor } from "../../shared/uptime-test-monitors"
import { component, componentId, incident, incidentId, statusPage } from "../test-pages"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { moved } from "./update-components"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const PUBLIC_ID = Schema.encodeSync(StatusPagePublicId)(statusPage().id)

type Fixture = Readonly<{
	tab?: string
	page?: V2StatusPage
	isAdmin?: boolean
	components?: ReturnType<typeof component>[]
	incidents?: ReturnType<typeof incident>[]
	monitorsFail?: boolean
	componentsFail?: boolean
}>

const loaded = (fixture: Fixture = {}): Model => {
	const entered = init(
		{
			_tag: "AlertsStatusPage",
			pageId: PUBLIC_ID,
			search: fixture.tab === undefined ? {} : { tab: fixture.tab },
		},
		context,
	).model
	return [
		Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12) }),
		Message.CompletedFetchSession({ orgId: ORG, isAdmin: fixture.isAdmin ?? true }),
		Message.CompletedFetchPage({
			key: entered.page.key ?? "",
			result: Result.succeed(fixture.page ?? statusPage()),
		}),
		Message.CompletedFetchComponents({
			key: entered.components.key ?? "",
			result: fixture.componentsFail
				? Result.fail(toLoadFailure(new Error("components unavailable")))
				: Result.succeed(fixture.components ?? [component(1), component(2), component(3)]),
		}),
		Message.CompletedFetchIncidents({
			key: entered.incidents.key ?? "",
			result: Result.succeed(fixture.incidents ?? []),
		}),
		Message.CompletedFetchMonitors({
			key: entered.monitors.key ?? "",
			result: fixture.monitorsFail
				? Result.fail(toLoadFailure(new Error("monitors unavailable")))
				: Result.succeed([httpMonitor(), downMonitor()]),
		}),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

const mounted = () => Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

describe("status page editor", () => {
	test("entering reads the page, its components, incidents and the monitors", () => {
		const entered = init({ _tag: "AlertsStatusPage", pageId: PUBLIC_ID, search: {} }, context)
		const sent = names(entered.commands)
		expect(sent).toContain("FetchStatusPage")
		expect(sent).toContain("FetchStatusPageComponents")
		expect(sent).toContain("FetchStatusPageIncidents")
		expect(sent).toContain("FetchStatusPageMonitors")
	})

	test("an id that is not a page id shows not found without a read", () => {
		const entered = init({ _tag: "AlertsStatusPage", pageId: "nope", search: {} }, context)
		expect(names(entered.commands)).not.toContain("FetchStatusPage")
		scene(
			{ update: pageUpdate, view },
			given(entered.model),
			expectView(text("Status page not found")).toExist(),
		)
	})

	test("the header shows the worst component, here one whose monitor is down", () => {
		const model = loaded({ components: [component(1), component(2, { monitor_id: downMonitor().id })] })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("heading", { name: /^Acme Status\s*Major outage$/u })).toExist(),
			expectView(text("/s/acme-status")).toExist(),
		)
	})
})

describe("read failures", () => {
	test("a failed monitors read shows an error, not every component Operational", () => {
		const model = loaded({
			components: [component(1, { monitor_id: downMonitor().id })],
			monitorsFail: true,
		})
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Couldn't load components")).toExist(),
			expectView(role("heading", { name: /^Acme Status$/u })).toExist(),
			expectView(text("Operational")).not.toExist(),
		)
	})
})

describe("read failures on the incidents tab", () => {
	test("a failed components read shows an error rather than incidents with no components", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "incidents", componentsFail: true })),
			expectView(text("Couldn't load incidents")).toExist(),
			expectView(role("button", { name: "New incident" })).not.toExist(),
		)
	})
})

describe("components tab", () => {
	test("moving a component down sends the whole new order once and shows it at once", () => {
		const moving = pageUpdate(
			loaded(),
			Message.ClickedMoveComponent({ componentId: componentId(1), offset: 1 }),
		)
		expect(moving.commands).toMatchObject([
			{
				name: "ReorderStatusPageComponents",
				args: { componentIds: [componentId(2), componentId(1), componentId(3)] },
			},
		])
		expect(
			pageUpdate(moving.model, Message.ClickedMoveComponent({ componentId: componentId(2), offset: 1 }))
				.commands ?? [],
		).toEqual([])
		const done = pageUpdate(moving.model, Message.CompletedReorder({ result: Result.succeed([]) }))
		expect(names(done.commands)).toContain("FetchStatusPageComponents")
	})

	test("the first component cannot move up and the last cannot move down", () => {
		const rows = [component(1), component(2)]
		expect(moved(rows, componentId(1), -1)).toBeNull()
		expect(moved(rows, componentId(2), 1)).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(loaded({ components: rows })),
			expectView(role("button", { name: "Move Component 1 up" })).toBeDisabled(),
			expectView(role("button", { name: "Move Component 2 down" })).toBeDisabled(),
			expectView(role("button", { name: "Move Component 1 down" })).not.toBeDisabled(),
		)
	})

	test("adding a component links the picked monitor and sends the cleared fields as null", () => {
		const monitor = downMonitor()
		const opened = pageUpdate(loaded(), Message.ClickedAddComponent()).model
		const filled = [
			Message.ChangedComponentField({ field: "name", value: " Payments " }),
			Message.ChangedComponentField({ field: "monitorId", value: monitor.id }),
			Message.ToggledComponentUptime(),
		].reduce((model, message) => pageUpdate(model, message).model, opened)
		const saving = pageUpdate(filled, Message.SubmittedComponent())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveStatusPageComponent",
				args: {
					componentId: null,
					payload: {
						name: "Payments",
						description: null,
						group: null,
						monitor_id: monitor.id,
						manual_status: null,
						show_uptime: false,
					},
				},
			},
		])
	})

	test("editing fills the dialog from the component", () => {
		const target = component(2, { name: "API", group: "Core", manual_status: "degraded" })
		const opened = pageUpdate(
			loaded({ components: [component(1), target] }),
			Message.ClickedEditComponent({ componentId: target.id }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted(),
			expectView(role("textbox", { name: "Name" })).toHaveValue("API"),
			expectView(role("textbox", { name: "Group" })).toHaveValue("Core"),
			expectView(role("button", { name: "Save component" })).toExist(),
		)
	})

	test("members see the components without the controls to change them", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ isAdmin: false })),
			expectView(text("Component 1")).toExist(),
			expectView(role("button", { name: "Add component" })).not.toExist(),
			expectView(role("button", { name: "Edit Component 1" })).not.toExist(),
		)
	})

	test("removing a component asks first, then deletes it once", () => {
		const asking = pageUpdate(loaded(), Message.ClickedDeleteComponent({ componentId: componentId(2) }))
		expect(asking.model.confirmDeleteComponentId).toBe(componentId(2))
		const deleting = pageUpdate(asking.model, Message.ClickedConfirmDeleteComponent())
		expect(deleting.commands).toMatchObject([
			{ name: "DeleteStatusPageComponent", args: { componentId: componentId(2) } },
		])
		expect(pageUpdate(deleting.model, Message.ClickedConfirmDeleteComponent()).commands ?? []).toEqual([])
	})
})

describe("incidents tab", () => {
	test("open incidents carry their actions, and a draft can be published", () => {
		const model = loaded({
			tab: "incidents",
			incidents: [
				incident(1, { published: false }),
				incident(2, { status: "resolved", title: "Old outage" }),
			],
		})
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Draft")).toExist(),
			expectView(role("button", { name: "Publish draft" })).toExist(),
			expectView(role("button", { name: "Resolve" })).toExist(),
			expectView(text("Old outage")).toExist(),
		)
		expect(
			pageUpdate(model, Message.ClickedPublishIncident({ incidentId: incidentId(1) })).commands,
		).toMatchObject([{ name: "PublishStatusPageIncident", args: { incidentId: incidentId(1) } }])
	})

	test("resolving posts a resolved update with the closing message", () => {
		const model = loaded({ tab: "incidents", incidents: [incident(1)] })
		const opened = pageUpdate(
			model,
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
		)
		const posting = pageUpdate(opened.model, Message.SubmittedUpdate())
		expect(posting.commands).toMatchObject([
			{
				name: "PostStatusPageIncidentUpdate",
				args: {
					incidentId: incidentId(1),
					payload: { status: "resolved", body: "This incident has been resolved." },
				},
			},
		])
	})

	test("Post update moves the status one step along and needs a message", () => {
		const model = loaded({ tab: "incidents", incidents: [incident(1, { status: "identified" })] })
		const opened = pageUpdate(
			model,
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
		)
		expect(opened.model.updateForm?.status).toBe("monitoring")
		expect(pageUpdate(opened.model, Message.SubmittedUpdate()).commands ?? []).toEqual([])
	})

	test("an incident saved as a draft names its components and is not published", () => {
		const opened = pageUpdate(
			loaded({ tab: "incidents" }),
			Message.ClickedNewIncident({ kind: "incident" }),
		).model
		const filled = [
			Message.ChangedIncidentField({ field: "title", value: "Slow checkout" }),
			Message.ChangedIncidentField({ field: "impact", value: "critical" }),
			Message.ToggledIncidentComponent({ componentId: componentId(2) }),
			Message.ChangedIncidentField({ field: "body", value: "Checkout is slow." }),
			Message.PickedIncidentPublished({ isPublished: false }),
		].reduce((current, message) => pageUpdate(current, message).model, opened)
		expect(pageUpdate(filled, Message.SubmittedIncident()).commands).toMatchObject([
			{
				name: "CreateStatusPageIncident",
				args: {
					payload: {
						kind: "incident",
						title: "Slow checkout",
						impact: "critical",
						status: "investigating",
						component_ids: [componentId(2)],
						body: "Checkout is slow.",
						published: false,
					},
				},
			},
		])
	})

	test("maintenance needs a window that ends after it starts, read in the viewer's zone", () => {
		const zoned: PageContext = { ...context, timeZone: "Europe/Berlin" }
		const opened = update(
			loaded({ tab: "incidents" }),
			Message.ClickedNewIncident({ kind: "maintenance" }),
			zoned,
		).model
		const filled = [
			Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
			Message.ChangedIncidentField({ field: "body", value: "Brief read-only periods." }),
			Message.ChangedIncidentField({ field: "scheduledStart", value: "2026-10-30T22:00" }),
			Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-30T21:00" }),
		].reduce((current, message) => update(current, message, zoned).model, opened)
		expect(update(filled, Message.SubmittedIncident(), zoned).commands ?? []).toEqual([])
		const fixed = update(
			filled,
			Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-31T01:00" }),
			zoned,
		).model
		expect(update(fixed, Message.SubmittedIncident(), zoned).commands).toMatchObject([
			{
				name: "CreateStatusPageIncident",
				args: {
					payload: {
						kind: "maintenance",
						status: "scheduled",
						scheduled_start: "2026-10-30T21:00:00.000Z",
						scheduled_end: "2026-10-31T00:00:00.000Z",
					},
				},
			},
		])
	})

	test("the composer lists what is missing before it can be sent", () => {
		const opened = pageUpdate(
			loaded({ tab: "incidents" }),
			Message.ClickedNewIncident({ kind: "maintenance" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted(),
			expectView(text("Add a title.")).toExist(),
			type(role("textbox", { name: "Title" }), "Database upgrade"),
			type(role("textbox", { name: "Message" }), "Brief read-only periods."),
			expectView(text("Set when the maintenance starts and ends.")).toExist(),
			expectView(role("button", { name: "Schedule" })).toBeDisabled(),
		)
	})
})

describe("settings tab", () => {
	test("an edit raises the save bar, and a bad color blocks the save", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings" })),
			expectView(text("Unsaved changes")).not.toExist(),
			type(role("textbox", { name: "Brand color" }), "teal"),
			expectView(text("Unsaved changes")).toExist(),
			expectView(text("Use a hex color like #1a2b3c.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("saving sends every field and settles once the page matches", () => {
		const edited = [
			Message.ChangedSetting({ field: "brandColor", value: "#1A2B3C" }),
			Message.ChangedSetting({ field: "autoIncidents", value: "publish" }),
			Message.ToggledPoweredBy(),
		].reduce((model, message) => pageUpdate(model, message).model, loaded({ tab: "settings" }))
		const saving = pageUpdate(edited, Message.ClickedSaveSettings())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveStatusPageSettings",
				args: {
					payload: {
						name: "Acme Status",
						slug: "acme-status",
						brand_color: "#1a2b3c",
						show_powered_by: false,
						auto_incidents: "publish",
						website_url: null,
					},
				},
			},
		])
		const saved = statusPage({
			brand_color: "#1A2B3C",
			show_powered_by: false,
			auto_incidents: "publish",
		})
		const done = pageUpdate(
			saving.model,
			Message.CompletedSaveSettings({ result: Result.succeed(saved) }),
		)
		expect(done.model.settingsEdits).toBeNull()
	})

	test("the first break-glass token is issued at once and shown once", () => {
		const issuing = pageUpdate(loaded({ tab: "settings" }), Message.ClickedRotateToken())
		expect(names(issuing.commands)).toEqual(["RotateStatusPageBreakGlassToken"])
		const issued = pageUpdate(
			issuing.model,
			Message.CompletedRotateToken({
				result: Result.succeed({
					id: statusPage().id,
					object: "status_page.break_glass_token",
					token: "mstat_secret_value_123456",
					token_suffix: "123456",
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(issued),
			expectView(selector('[id="status-page-break-glass-token"]')).toHaveValue(
				"mstat_secret_value_123456",
			),
			click(role("button", { name: "Done" })),
			expectView(
				text("Store it outside Maple, in your password manager. It is not shown again."),
			).not.toExist(),
		)
	})

	test("replacing or revoking an issued token asks first", () => {
		const model = loaded({ tab: "settings", page: statusPage({ break_glass_token_suffix: "ABC123" }) })
		const replacing = pageUpdate(model, Message.ClickedRotateToken())
		expect(names(replacing.commands)).not.toContain("RotateStatusPageBreakGlassToken")
		expect(replacing.model.breakGlassDialog.isOpen).toBe(true)
		const revoking = pageUpdate(model, Message.ClickedRevokeToken())
		expect(revoking.model.breakGlassAction).toBe("revoke")
		expect(pageUpdate(revoking.model, Message.ClickedConfirmBreakGlass()).commands).toMatchObject([
			{ name: "RevokeStatusPageBreakGlassToken" },
		])
	})

	test("deleting the page confirms, then returns to the status pages tab", () => {
		const asking = pageUpdate(loaded({ tab: "settings" }), Message.ClickedDeletePage())
		const deleting = pageUpdate(asking.model, Message.ClickedConfirmDeletePage())
		expect(names(deleting.commands)).toEqual(["DeleteStatusPage"])
		const done = pageUpdate(
			deleting.model,
			Message.CompletedDeletePage({ result: Result.succeed(undefined) }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: statusPagesTabHref(),
				isReplace: true,
				toast: { type: "success", title: "Status page deleted", description: "" },
			}),
		)
	})
})
