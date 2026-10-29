import { OrgId } from "@maple/domain"
import {
	StatusPageComponentPublicId,
	type StatusPageConfig,
	StatusPagePublicId,
	type V2StatusPage,
} from "@maple/domain/http/v2"
import { DEFAULT_STATUS_PAGE_THEME } from "@maple/domain/status-page"
import { Option, Result, Schema } from "effect"
import {
	attr,
	Command,
	click,
	expect as expectView,
	find,
	given,
	inside,
	role,
	scene,
	selector,
	tap,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { statusPagesHref } from "../shared/commands"
import { selectionOf } from "../shared/preview"
import { ORG } from "../../alerts/shared/test-rows"
import { downMonitor, httpMonitor } from "../../alerts/shared/uptime-test-monitors"
import {
	component,
	componentId,
	incident,
	incidentId,
	statusPage,
	statusPageConfig,
} from "../shared/test-pages"
import { PickerMessage } from "../shared/picker"
import { FocusEditorElement } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { moved } from "./update-components"
import { canvasDocument } from "./view-canvas"
import { removeComponentCopy, view as pageView } from "./view"

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
	/** The config read's document; by default the page and its components. */
	config?: StatusPageConfig
	configFail?: boolean
}>

const loaded = (fixture: Fixture = {}): Model => {
	const entered = init(
		{
			_tag: "StatusPage",
			pageId: PUBLIC_ID,
			search: fixture.tab === undefined ? {} : { view: fixture.tab },
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
		// Only the JSON tab reads the config.
		...(entered.config.key === null
			? []
			: [
					Message.CompletedFetchConfig({
						key: entered.config.key,
						result: fixture.configFail
							? Result.fail(toLoadFailure(new Error("config unavailable")))
							: Result.succeed(
									fixture.config ??
										statusPageConfig(
											fixture.page ?? statusPage(),
											fixture.components ?? [component(1), component(2), component(3)],
										),
								),
					}),
				]),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

describe("status page editor", () => {
	test("entering reads the page, its components, incidents and the monitors", () => {
		const entered = init({ _tag: "StatusPage", pageId: PUBLIC_ID, search: {} }, context)
		const sent = names(entered.commands)
		expect(sent).toContain("FetchStatusPage")
		expect(sent).toContain("FetchStatusPageComponents")
		expect(sent).toContain("FetchStatusPageIncidents")
		expect(sent).toContain("FetchStatusPageMonitors")
	})

	test("fresh page and incident reads re-read the clock, so relative times never run ahead", () => {
		const entered = init({ _tag: "StatusPage", pageId: PUBLIC_ID, search: {} }, context).model
		const afterPage = pageUpdate(
			entered,
			Message.CompletedFetchPage({ key: entered.page.key ?? "", result: Result.succeed(statusPage()) }),
		)
		const afterIncidents = pageUpdate(
			entered,
			Message.CompletedFetchIncidents({ key: entered.incidents.key ?? "", result: Result.succeed([]) }),
		)
		expect(names(afterPage.commands)).toContain("ReadStatusPageClock")
		expect(names(afterIncidents.commands)).toContain("ReadStatusPageClock")
	})

	test("an id that is not a page id shows not found without a read", () => {
		const entered = init({ _tag: "StatusPage", pageId: "nope", search: {} }, context)
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
			expectView(text("Couldn't load the page's components")).toExist(),
			expectView(role("heading", { name: /^Acme Status$/u })).toExist(),
			expectView(text("Operational")).not.toExist(),
		)
	})
})

describe("the page as the editor", () => {
	const selected = (componentNumber: number, fixture: Fixture = {}) =>
		pageUpdate(loaded(fixture), Message.ClickedComponent({ componentId: componentId(componentNumber) }))
			.model

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

	test("a component picked in the On this page list opens in the panel with its fields", () => {
		const target = component(2, { name: "API", group: "Core", manual_status: "degraded" })
		scene(
			{ update: pageUpdate, view },
			given(loaded({ components: [component(1), target] })),
			click(role("button", { name: /^API/u })),
			Command.resolve(FocusEditorElement, Message.CompletedFocus()),
			expectView(role("textbox", { name: "Shown as" })).toHaveValue("API"),
			expectView(role("textbox", { name: "Group" })).toHaveValue("Core"),
			expectView(role("button", { name: /^API/u })).toHaveAttr("aria-pressed", "true"),
		)
	})

	test("a click in the preview selects the component or incident it names; unknown ids do nothing", () => {
		const model = loaded({ incidents: [incident(1)] })
		const picked = pageUpdate(
			model,
			Message.ReceivedPreviewSelection({ kind: "component", id: componentId(3) }),
		)
		expect(picked.model.panel).toEqual({ _tag: "Component", componentId: componentId(3) })
		expect(picked.model.componentForm.name).toBe("Component 3")
		const incidentPicked = pageUpdate(
			model,
			Message.ReceivedPreviewSelection({ kind: "incident", id: incidentId(1) }),
		)
		expect(incidentPicked.model.panel).toEqual({ _tag: "Incident", incidentId: incidentId(1) })
		expect(
			pageUpdate(model, Message.ReceivedPreviewSelection({ kind: "component", id: "elsewhere" })).model
				.panel,
		).toBeNull()
	})

	test("a preview message that is not exactly a selection is ignored", () => {
		expect(selectionOf({ type: "select", kind: "component", id: componentId(1) })).toEqual(
			Option.some({ kind: "component", id: componentId(1) }),
		)
		expect(selectionOf({ type: "navigate", kind: "component", id: componentId(1) })).toEqual(
			Option.none(),
		)
		expect(selectionOf({ type: "select", kind: "page", id: componentId(1) })).toEqual(Option.none())
		expect(selectionOf({ type: "select", kind: "component", id: "<script>" })).toEqual(Option.none())
		expect(selectionOf("select")).toEqual(Option.none())
	})

	test("the preview outlines the selection and marks components and incidents to click", () => {
		const model = selected(2, { incidents: [incident(1)] })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(selector("iframe")).toHaveAttr("sandbox", "allow-scripts"),
		)
		const document = canvasDocument(model, statusPage())
		const outlined = (id: string) => new RegExp(`\\[data-component-id="${id}"\\][^{]*\\{outline:2px`, "u")
		expect(document).toMatch(outlined(componentId(2)))
		expect(document).not.toMatch(outlined(componentId(1)))
		expect(document).toContain(`data-incident-id="${incidentId(1)}"`)
		expect(document).toContain(`data-component-id="${componentId(1)}"`)
	})

	test("a field saves on blur with one PATCH of the whole component, and only when it changed", () => {
		const editing = pageUpdate(
			selected(2),
			Message.ChangedComponentField({ field: "name", value: " Payments " }),
		)
		const saving = pageUpdate(editing.model, Message.CommittedComponent())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveStatusPageComponent",
				args: {
					componentId: componentId(2),
					payload: {
						name: "Payments",
						group: null,
						monitor_id: null,
						manual_status: null,
						show_uptime: true,
					},
				},
			},
		])
		expect(pageUpdate(selected(2), Message.CommittedComponent()).commands ?? []).toEqual([])
		const saved = pageUpdate(
			saving.model,
			Message.CompletedSaveComponent({ result: Result.succeed(component(2, { name: "Payments" })) }),
		)
		scene({ update: pageUpdate, view }, given(saved.model), expectView(text("Saved")).toExist())
	})

	test("picking a monitor saves at once and a failed save says so in the panel", () => {
		const monitor = downMonitor()
		const saving = pageUpdate(
			selected(1),
			Message.PickedComponentField({ field: "monitorId", value: monitor.id }),
		)
		expect(saving.commands).toMatchObject([
			{ name: "SaveStatusPageComponent", args: { payload: { monitor_id: monitor.id } } },
		])
		const failed = pageUpdate(
			saving.model,
			Message.CompletedSaveComponent({ result: Result.fail(toLoadFailure(new Error("refused"))) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Not saved")).toExist(),
			expectView(text("Couldn't save the component")).toExist(),
		)
	})

	test("a component without a monitor shows its stored uptime setting, disabled, and says why", () => {
		scene(
			{ update: pageUpdate, view },
			given(selected(1)),
			expectView(role("checkbox", { name: "Show uptime bars" })).toBeChecked(),
			expectView(role("checkbox", { name: "Show uptime bars" })).toBeDisabled(),
			expectView(text("Uptime bars need a monitor.")).toExist(),
		)
	})

	test("the remove confirm names the monitor only when there is one, and the draft wording for drafts", () => {
		expect(removeComponentCopy(statusPage(), component(1, { monitor_id: httpMonitor().id }))).toBe(
			"Visitors stop seeing it within a minute. Its monitor keeps running.",
		)
		expect(removeComponentCopy(statusPage(), component(1))).toBe(
			"Visitors stop seeing it within a minute.",
		)
		expect(removeComponentCopy(statusPage({ draft: true }), component(1))).toBe(
			"It leaves the draft; visitors never see it.",
		)
	})

	test("Escape closes the panel", () => {
		expect(pageUpdate(selected(1), Message.PressedEscape()).model.panel).toBeNull()
	})

	test("removing a component asks first, then deletes it once", () => {
		const asking = pageUpdate(
			selected(2),
			Message.ClickedDeleteComponent({ componentId: componentId(2) }),
		)
		expect(asking.model.confirmDeleteComponentId).toBe(componentId(2))
		expect(asking.model.deleteComponentDialog.isOpen).toBe(true)
		expect(names(asking.commands)).not.toContain("DeleteStatusPageComponent")
		const deleting = pageUpdate(asking.model, Message.ClickedConfirmDeleteComponent())
		expect(deleting.commands).toMatchObject([
			{ name: "DeleteStatusPageComponent", args: { componentId: componentId(2) } },
		])
		expect(pageUpdate(deleting.model, Message.ClickedConfirmDeleteComponent()).commands ?? []).toEqual([])
	})

	test("Add component offers the monitors not on the page yet and adds the picked ones", () => {
		const monitor = downMonitor()
		const opened = pageUpdate(
			loaded({ components: [component(1, { monitor_id: httpMonitor().id })] }),
			Message.ClickedAddComponent(),
		).model
		expect(opened.addPicker.rows.map((row) => row.monitorId)).toEqual([monitor.id])
		const picked = pageUpdate(
			opened,
			Message.GotAddPickerMessage({ message: PickerMessage.ToggledRow({ key: `m:${monitor.id}` }) }),
		).model
		expect(pageUpdate(picked, Message.ClickedSubmitAdd()).commands).toMatchObject([
			{
				name: "AddStatusPageComponents",
				args: { components: [{ name: monitor.name, monitor_id: monitor.id }] },
			},
		])
	})

	test("members see the page and its components without any control to change them", () => {
		scene(
			{ update: pageUpdate, view },
			given(selected(1, { isAdmin: false })),
			expectView(text("Component 1")).toExist(),
			expectView(role("button", { name: "Add component" })).not.toExist(),
			expectView(role("button", { name: "Move Component 1 down" })).not.toExist(),
			expectView(role("button", { name: "Remove from page" })).not.toExist(),
			expectView(role("textbox", { name: "Shown as" })).toBeDisabled(),
			expectView(text("Only org admins can change components.")).toExist(),
		)
		expect(
			pageUpdate(selected(1, { isAdmin: false }), Message.ClickedAddComponent()).model.panel?._tag,
		).toBe("Component")
	})
})

describe("incidents in the panel", () => {
	test("switching between incident and maintenance keeps what was typed", () => {
		const typed = [
			Message.ClickedNewIncident({ kind: "incident" }),
			Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
			Message.ChangedIncidentField({ field: "body", value: "Planned work." }),
		].reduce((model, message) => pageUpdate(model, message).model, loaded())
		const switched = pageUpdate(typed, Message.ChangedIncidentKind({ kind: "maintenance" })).model
		expect(switched.incidentForm).toMatchObject({
			kind: "maintenance",
			title: "Database upgrade",
			body: "Planned work.",
			status: "scheduled",
			impact: "none",
			componentIds: typed.incidentForm.componentIds,
		})
	})

	test("an open incident carries its actions, and a draft can be published", () => {
		const model = pageUpdate(
			loaded({
				incidents: [
					incident(1, { published: false }),
					incident(2, { status: "resolved", title: "Old outage" }),
				],
			}),
			Message.ClickedIncident({ incidentId: incidentId(1) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Draft, not public")).toExist(),
			expectView(role("button", { name: "Publish" })).toExist(),
			expectView(role("button", { name: "Resolve" })).toExist(),
			expectView(role("button", { name: "Old outage" })).toExist(),
		)
		expect(
			pageUpdate(model, Message.ClickedPublishIncident({ incidentId: incidentId(1) })).commands,
		).toMatchObject([{ name: "PublishStatusPageIncident", args: { incidentId: incidentId(1) } }])
	})

	test("resolving posts a resolved update with the closing message", () => {
		const model = loaded({ incidents: [incident(1)] })
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
		const model = loaded({ incidents: [incident(1, { status: "identified" })] })
		const opened = pageUpdate(
			model,
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
		)
		expect(opened.model.updateForm?.status).toBe("monitoring")
		expect(pageUpdate(opened.model, Message.SubmittedUpdate()).commands ?? []).toEqual([])
	})

	test("Post incident opens the composer in the panel, with the affected components picked", () => {
		const model = loaded({ components: [component(1), component(2, { monitor_id: downMonitor().id })] })
		scene(
			{ update: pageUpdate, view },
			given(model),
			click(role("button", { name: "Post incident" })),
			Command.resolve(FocusEditorElement, Message.CompletedFocus()),
			expectView(role("textbox", { name: "Title" })).toExist(),
			expectView(role("checkbox", { name: "Component 2" })).toBeChecked(),
			expectView(role("checkbox", { name: "Component 1" })).not.toBeChecked(),
			expectView(role("dialog")).not.toExist(),
		)
		const opened = pageUpdate(model, Message.ClickedNewIncident({ kind: "incident" })).model
		expect(opened.incidentForm.impact).toBe("critical")
	})

	test("an incident saved as a draft names its components and is not published", () => {
		const opened = pageUpdate(loaded(), Message.ClickedNewIncident({ kind: "incident" })).model
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
		const opened = update(loaded(), Message.ClickedNewIncident({ kind: "maintenance" }), zoned).model
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
		const opened = pageUpdate(loaded(), Message.ClickedNewIncident({ kind: "maintenance" })).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			expectView(text("Add a title.")).toExist(),
			type(role("textbox", { name: "Title" }), "Database upgrade"),
			type(role("textbox", { name: "Message" }), "Brief read-only periods."),
			expectView(text("Set when the maintenance starts and ends.")).toExist(),
			expectView(role("button", { name: "Schedule" })).toBeDisabled(),
		)
	})
})

describe("drafts", () => {
	test("a draft page says it is not public and offers Publish, which goes to the live screen", () => {
		const model = loaded({ page: statusPage({ draft: true, published_at: null }) })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Draft, not public")).toExist(),
			expectView(text("Draft. Nothing is public until you publish.")).toExist(),
			expectView(role("button", { name: "Publish" })).toExist(),
		)
		const publishing = pageUpdate(model, Message.ClickedPublish())
		expect(names(publishing.commands)).toEqual(["PublishStatusPage"])
		const done = pageUpdate(
			publishing.model,
			Message.CompletedPublish({
				result: Result.succeed({
					id: statusPage().id,
					object: "status_page.publish_result",
					outcome: "published",
					revision: 4,
				}),
			}),
		)
		expect(done.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: `/status-pages/${PUBLIC_ID}?view=live`,
		})
	})
})

describe("live screen", () => {
	const live = (publicBaseUrl: string): Model => ({ ...loaded({ tab: "live" }), publicBaseUrl })

	test("with a status domain: the full address to copy and open, and the next steps", () => {
		scene(
			{ update: pageUpdate, view },
			given(live("https://status-pr-7.maple.dev")),
			expectView(role("heading", { name: "Acme Status is live" })).toExist(),
			expectView(selector("#status-page-public-url")).toHaveValue(
				"https://status-pr-7.maple.dev/s/acme-status",
			),
			expectView(role("link", { name: "Open" })).toHaveAttr(
				"href",
				"https://status-pr-7.maple.dev/s/acme-status",
			),
			expectView(role("button", { name: "Copy public address" })).toExist(),
			expectView(role("button", { name: "Get break-glass token" })).toExist(),
			expectView(role("link", { name: "Page JSON" })).toHaveAttr(
				"href",
				`/status-pages/${PUBLIC_ID}?view=json`,
			),
		)
	})

	test("without a status domain: a note in place of the address, no link, and publishing still works", () => {
		const model = live("")
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Public address appears once a status domain is configured")).toExist(),
			expectView(selector("#status-page-public-url")).not.toExist(),
			expectView(role("link", { name: "Open" })).not.toExist(),
			expectView(role("link", { name: /\/s\/acme-status/u })).not.toExist(),
			expectView(role("button", { name: "Get break-glass token" })).toExist(),
		)
		const draft = {
			...loaded({ page: statusPage({ draft: true, published_at: null }) }),
			publicBaseUrl: "",
		}
		expect(names(pageUpdate(draft, Message.ClickedPublish()).commands)).toEqual(["PublishStatusPage"])
	})

	test("the header links the public page once a status domain is set", () => {
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded(), publicBaseUrl: "https://status-pr-7.maple.dev" }),
			expectView(role("link", { name: "https://status-pr-7.maple.dev/s/acme-status" })).toHaveAttr(
				"href",
				"https://status-pr-7.maple.dev/s/acme-status",
			),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded(), publicBaseUrl: "" }),
			expectView(text("Public address appears once a status domain is configured")).toExist(),
		)
	})

	test("Get break-glass token issues one at once and shows it once", () => {
		const issuing = pageUpdate(loaded({ tab: "live" }), Message.ClickedRotateToken())
		expect(names(issuing.commands)).toEqual(["RotateStatusPageBreakGlassToken"])
	})
})

describe("settings view", () => {
	test("an edit raises the save bar, and a bad color blocks the save", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings" })),
			expectView(text("Unsaved changes")).not.toExist(),
			type(role("textbox", { name: "Accent" }), "teal"),
			expectView(text("Unsaved changes")).toExist(),
			expectView(text("Use a hex color like #1a2b3c.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("a footer link must use https before the settings save", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings" })),
			type(role("textbox", { name: "Terms of service URL" }), "http://acme.example/terms"),
			expectView(text("Use an https URL.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("saving sends every field and settles once the page matches", () => {
		const edited = [
			Message.ChangedThemeColor({ field: "accent", value: "#1A2B3C" }),
			Message.PickedThemePreset({ preset: "paper" }),
			Message.ChangedSetting({ field: "autoIncidents", value: "publish" }),
			Message.ToggledPoweredBy(),
			Message.ChangedSetting({ field: "privacyUrl", value: " https://acme.example/privacy " }),
		].reduce((model, message) => pageUpdate(model, message).model, loaded({ tab: "settings" }))
		const saving = pageUpdate(edited, Message.ClickedSaveSettings())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveStatusPageSettings",
				args: {
					payload: {
						name: "Acme Status",
						slug: "acme-status",
						theme: { ...DEFAULT_STATUS_PAGE_THEME, preset: "paper", accent: "#1a2b3c" },
						show_powered_by: false,
						auto_incidents: "publish",
						website_url: null,
						privacy_url: "https://acme.example/privacy",
						terms_url: null,
					},
				},
			},
		])
		const saved = statusPage({
			theme: { ...DEFAULT_STATUS_PAGE_THEME, preset: "paper", accent: "#1a2b3c" },
			show_powered_by: false,
			auto_incidents: "publish",
			privacy_url: "https://acme.example/privacy",
		})
		const done = pageUpdate(
			saving.model,
			Message.CompletedSaveSettings({ result: Result.succeed(saved) }),
		)
		expect(done.model.settingsEdits).toBeNull()
	})

	test("Auto disables the colour overrides but not the accent", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings" })),
			expectView(role("textbox", { name: "Background" })).toBeDisabled(),
			expectView(role("textbox", { name: "Text" })).toBeDisabled(),
			expectView(role("textbox", { name: "Accent" })).toBeEnabled(),
			inside(role("group", { name: "Mode" }), click(role("button", { name: "Dark" }))),
			expectView(role("textbox", { name: "Background" })).toBeEnabled(),
		)
	})

	test("an unreadable text colour shows its contrast and blocks the save", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings" })),
			inside(role("group", { name: "Mode" }), click(role("button", { name: "Light" }))),
			type(role("textbox", { name: "Text" }), "#777777"),
			expectView(
				text("Text on the background has a contrast of 4.48:1; it needs at least 4.5:1."),
			).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("the preview is a sandboxed page that follows the draft accent and preview mode", () => {
		const iframeOf = find("iframe")
		const srcdoc = (html: Parameters<typeof iframeOf>[0]): string =>
			Option.getOrElse(Option.flatMap(iframeOf(html), attr("srcdoc")), () => "")
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings" })),
			// Scripts page the bars; without `allow-same-origin` the page still reaches nothing of ours.
			expectView(selector("iframe")).toHaveAttr("sandbox", "allow-scripts"),
			tap(({ html }) => {
				expect(srcdoc(html)).toContain("Acme Status")
				expect(srcdoc(html)).toContain("color-scheme:light;")
			}),
			// The preview mode is for looking only: it is not a page edit.
			inside(role("group", { name: "Preview mode" }), click(role("button", { name: "Dark" }))),
			tap(({ html }) => expect(srcdoc(html)).toContain("color-scheme:dark;")),
			expectView(text("Unsaved changes")).not.toExist(),
			type(role("textbox", { name: "Accent" }), "#ff0066"),
			tap(({ html }) => expect(srcdoc(html)).toContain("--link:#ff0066")),
		)
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
				url: statusPagesHref(),
				isReplace: true,
				toast: { type: "success", title: "Status page deleted", description: "" },
			}),
		)
	})
})

describe("json view", () => {
	const publicComponentId = (n: number) => Schema.encodeSync(StatusPageComponentPublicId)(componentId(n))
	/** The document the tab shows, as the user would edit it. */
	const documentOf = (components: ReadonlyArray<number>) => ({
		name: "Acme Status",
		slug: "acme-status",
		components: components.map((n) => ({ id: publicComponentId(n), name: `Component ${n}` })),
	})
	const editing = (draft: string, fixture: Fixture = {}) =>
		[Message.ClickedEditJson(), Message.ChangedJson({ value: draft })].reduce(
			(model, message) => pageUpdate(model, message).model,
			loaded({ tab: "json", ...fixture }),
		)

	test("shows the page as its config document, with public ids", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "json" })),
			expectView(role("link", { name: "Back to page" })).toHaveAttr(
				"href",
				`/status-pages/${PUBLIC_ID}`,
			),
			expectView(selector("pre")).toContainText('"slug": "acme-status"'),
			expectView(selector("pre")).toContainText(`"id": "${publicComponentId(2)}"`),
			expectView(selector("pre")).toContainText('"auto_incidents": "draft"'),
			expectView(role("button", { name: "Copy config JSON" })).toExist(),
			expectView(text("GET /v2/status_pages/{id}/config")).toExist(),
		)
	})

	test("members read the document but cannot edit it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "json", isAdmin: false })),
			expectView(selector("pre")).toContainText('"name": "Acme Status"'),
			expectView(role("button", { name: "Edit JSON" })).not.toExist(),
			expectView(role("textbox", { name: "Config JSON" })).not.toExist(),
		)
		const tried = pageUpdate(loaded({ tab: "json", isAdmin: false }), Message.ClickedEditJson())
		expect(tried.model.jsonDraft).toBeNull()
	})

	test("Edit fills the editor with the current document, and Reset brings it back", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "json" })),
			click(role("button", { name: "Edit JSON" })),
			expectView(role("textbox", { name: "Config JSON" })).toExist(),
			expectView(text("No changes yet.")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
			type(role("textbox", { name: "Config JSON" }), "{}"),
			expectView(text("Not a valid page config")).toExist(),
			click(role("button", { name: "Reset" })),
			expectView(text("No changes yet.")).toExist(),
		)
	})

	test("invalid JSON shows where it breaks and disables Apply", () => {
		scene(
			{ update: pageUpdate, view },
			given(editing('{\n  "name": "Acme",\n  "slug" "acme"\n}')),
			expectView(text("Invalid JSON")).toExist(),
			expectView(text("Line 3, column 10: Expected ':' after the property name")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
	})

	test("a schema error names the path of the bad field", () => {
		const draft = JSON.stringify({ ...documentOf([1]), components: [{ name: "" }] })
		scene(
			{ update: pageUpdate, view },
			given(editing(draft)),
			expectView(text("Not a valid page config")).toExist(),
			expectView(text(/^components\[0\]\.name: /u)).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
	})

	test("an id from elsewhere is refused before the write", () => {
		const draft = JSON.stringify({
			...documentOf([1]),
			components: [{ id: publicComponentId(9), name: "X" }],
		})
		scene(
			{ update: pageUpdate, view },
			given(editing(draft)),
			expectView(
				text(
					`components[0].id: ${publicComponentId(9)} is not a component of this page. Remove the id to add a new one.`,
				),
			).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
	})

	test("the summary lists a created and a deleted component", () => {
		const draft = JSON.stringify({
			...documentOf([1, 2]),
			components: [...documentOf([1, 2]).components, { name: "Status API" }],
		})
		scene(
			{ update: pageUpdate, view },
			given(editing(draft)),
			expectView(text("Components to create")).toExist(),
			expectView(text("Status API")).toExist(),
			expectView(text("Components to delete")).toExist(),
			expectView(text("Component 3")).toExist(),
			expectView(text("Fields changed")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeEnabled(),
		)
	})

	test("Apply sends one PUT with the decoded config, then re-reads the page and components", () => {
		const draft = JSON.stringify({ ...documentOf([2, 1]), components: documentOf([2, 1]).components })
		const model = editing(draft)
		const applying = pageUpdate(model, Message.ClickedApplyJson())
		expect(applying.commands).toMatchObject([
			{
				name: "ApplyStatusPageConfig",
				args: {
					pageId: statusPage().id,
					config: {
						name: "Acme Status",
						slug: "acme-status",
						components: [
							{ id: componentId(2), name: "Component 2" },
							{ id: componentId(1), name: "Component 1" },
						],
					},
				},
			},
		])
		expect(applying.commands).toHaveLength(1)
		expect(pageUpdate(applying.model, Message.ClickedApplyJson()).commands ?? []).toEqual([])

		const applied = pageUpdate(
			applying.model,
			Message.CompletedApplyJson({
				result: Result.succeed({ name: "Acme Status", slug: "acme-status", components: [] }),
			}),
		)
		expect(applied.model.jsonDraft).toBeNull()
		expect(names(applied.commands)).toContain("FetchStatusPage")
		expect(names(applied.commands)).toContain("FetchStatusPageComponents")
	})

	test("a refused apply shows the server's reason inline and keeps the draft", () => {
		const reason = "Text needs a contrast of 4.5:1"
		const model = editing(JSON.stringify(documentOf([1])))
		const applying = pageUpdate(model, Message.ClickedApplyJson()).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error(reason)),
					message: reason,
					retryable: false,
				}),
			}),
		).model
		expect(refused.jsonDraft).toBe(model.jsonDraft)
		scene(
			{ update: pageUpdate, view },
			given(refused),
			expectView(text("Couldn't apply the config")).toExist(),
			expectView(text(reason)).toExist(),
		)
	})

	test("the document comes from the config read, so components past the list's first page stay", () => {
		const entered = init({ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "json" } }, context)
		expect(names(entered.commands)).toContain("FetchStatusPageConfig")
		const listed = [component(1), component(2)]
		const config = statusPageConfig(statusPage(), [...listed, component(3), component(4)])
		const model = loaded({ tab: "json", components: listed, config })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(selector("pre")).toContainText(`"id": "${publicComponentId(4)}"`),
			click(role("button", { name: "Edit JSON" })),
			expectView(text("No changes yet.")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
		const dropped = JSON.stringify({ ...documentOf([1, 2, 3]) })
		const editingConfig = [Message.ClickedEditJson(), Message.ChangedJson({ value: dropped })].reduce(
			(current, message) => pageUpdate(current, message).model,
			model,
		)
		scene(
			{ update: pageUpdate, view },
			given(editingConfig),
			expectView(text("Components to delete")).toExist(),
			expectView(text("Component 4")).toExist(),
		)
	})

	test("the tab shows the config read's loading and failure states", () => {
		const entered = init(
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "json" } },
			context,
		).model
		const pageIn = pageUpdate(
			entered,
			Message.CompletedFetchPage({ key: entered.page.key ?? "", result: Result.succeed(statusPage()) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(pageIn),
			expectView(selector("pre")).not.toExist(),
			expectView(role("button", { name: "Edit JSON" })).not.toExist(),
		)
		const failed = loaded({ tab: "json", configFail: true })
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load the config")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toContain("FetchStatusPageConfig")
	})

	test("opening the tab re-reads the config, since other tabs write the page too", () => {
		const onSettings = loaded({ tab: "settings" })
		expect(onSettings.config.key).toBeNull()
		const opened = routeChanged(
			onSettings,
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "json" } },
			context,
		)
		expect(names(opened.commands)).toEqual(["FetchStatusPageConfig"])
	})

	test("Apply sends the version the document was read with", () => {
		const model = editing(JSON.stringify({ ...documentOf([1, 2]) }), {
			config: {
				...statusPageConfig(statusPage(), [component(1), component(2), component(3)]),
				version: "v7",
			},
		})
		expect(pageUpdate(model, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v7" } },
		])
	})

	test("a newer config read while editing does not replace the version the draft was opened from", () => {
		const base = {
			...statusPageConfig(statusPage(), [component(1), component(2), component(3)]),
			version: "v7",
		}
		const draft = editing(JSON.stringify({ ...documentOf([1, 2]) }), { config: base })
		// Someone else's edit lands and the tab re-reads it, mid-edit.
		const reread = pageUpdate(
			draft,
			Message.CompletedFetchConfig({
				key: draft.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v7" } },
		])
	})

	test("a draft that differs only by spacing or colour case is no change", () => {
		const theme = { ...DEFAULT_STATUS_PAGE_THEME, appearance: "light" as const, accent: "#1a2b3c" }
		const page = statusPage({ description: "Live status.", theme })
		const draft = JSON.stringify({
			...documentOf([1, 2, 3]),
			name: " Acme Status ",
			description: " Live status. ",
			auto_incidents: "draft",
			theme: { ...theme, accent: "#1A2B3C" },
			components: documentOf([1, 2, 3]).components.map((c) => ({
				...c,
				name: ` ${c.name}`,
				group: " ",
			})),
		})
		scene(
			{ update: pageUpdate, view },
			given(editing(draft, { page })),
			expectView(text("No changes yet.")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
	})

	test("while an apply runs, typing is ignored, the editor is disabled, and Settings cannot save", () => {
		const draft = JSON.stringify(documentOf([1]))
		const applying = pageUpdate(editing(draft), Message.ClickedApplyJson()).model
		expect(applying.isApplyingJson).toBe(true)
		expect(pageUpdate(applying, Message.ChangedJson({ value: "{}" })).model.jsonDraft).toBe(draft)
		scene(
			{ update: pageUpdate, view },
			given(applying),
			expectView(role("textbox", { name: "Config JSON" })).toBeDisabled(),
		)
		const edited = pageUpdate(
			applying,
			Message.ChangedSetting({ field: "name", value: "Typed meanwhile" }),
		).model
		expect(pageUpdate(edited, Message.ClickedSaveSettings()).commands ?? []).toEqual([])
	})

	test("a successful apply keeps Settings edits typed meanwhile and re-reads incidents and the config", () => {
		const draft = JSON.stringify(documentOf([1]))
		const applying = pageUpdate(editing(draft), Message.ClickedApplyJson()).model
		const typed = pageUpdate(
			applying,
			Message.ChangedSetting({ field: "name", value: "Typed meanwhile" }),
		).model
		const applied = (model: Model) =>
			pageUpdate(
				model,
				Message.CompletedApplyJson({
					result: Result.succeed({ ...documentOf([1]), components: [], version: "v8" }),
				}),
			)
		const kept = applied(typed)
		expect(kept.model.settingsEdits?.name).toBe("Typed meanwhile")
		expect(names(kept.commands)).toEqual(
			expect.arrayContaining(["FetchStatusPageIncidents", "FetchStatusPageConfig"]),
		)
		expect(applied(applying).model.settingsEdits).toBeNull()
	})

	test("a conflict keeps the draft, says why and re-reads the config", () => {
		const reason = "The page's config changed since it was read."
		const applying = pageUpdate(
			editing(JSON.stringify(documentOf([1]))),
			Message.ClickedApplyJson(),
		).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error(reason)),
					code: "status_page_conflict",
					message: reason,
					retryable: false,
				}),
			}),
		)
		expect(refused.model.jsonDraft).toBe(applying.jsonDraft)
		expect(names(refused.commands)).toEqual(["FetchStatusPageConfig"])
		scene({ update: pageUpdate, view }, given(refused.model), expectView(text(reason)).toExist())
	})

	test("after a conflict the re-read becomes the draft's base, so the next Apply can go through", () => {
		const base = { ...statusPageConfig(statusPage(), [component(1), component(2)]), version: "v7" }
		const draftText = JSON.stringify(documentOf([1]))
		const applying = pageUpdate(editing(draftText, { config: base }), Message.ClickedApplyJson()).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error("changed")),
					code: "status_page_conflict",
					message: "changed",
					retryable: false,
				}),
			}),
		).model
		const reread = pageUpdate(
			refused,
			Message.CompletedFetchConfig({
				key: refused.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(reread.jsonDraft).toBe(draftText)
		scene({ update: pageUpdate, view }, given(reread), expectView(text("changed")).not.toExist())
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v8" } },
		])
	})

	test("cancelling after a conflict ends the rebase, so a later draft keeps its own base", () => {
		const base = { ...statusPageConfig(statusPage(), [component(1), component(2)]), version: "v7" }
		const applying = pageUpdate(
			editing(JSON.stringify(documentOf([1])), { config: base }),
			Message.ClickedApplyJson(),
		).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error("changed")),
					code: "status_page_conflict",
					message: "changed",
					retryable: false,
				}),
			}),
		).model
		// Cancel before the re-read lands, then start a fresh draft on v7.
		const reopened = [Message.ClickedCancelJson(), Message.ClickedEditJson()].reduce(
			(model, message) => pageUpdate(model, message).model,
			refused,
		)
		const reread = pageUpdate(
			reopened,
			Message.CompletedFetchConfig({
				key: reopened.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(reread.jsonBase?.version).toBe("v7")
	})

	test("a config read superseded by the conflict re-read does not rebase the draft", () => {
		const base = { ...statusPageConfig(statusPage(), [component(1), component(2)]), version: "v7" }
		const applying = pageUpdate(
			editing(JSON.stringify(documentOf([1])), { config: base }),
			Message.ClickedApplyJson(),
		).model
		const staleKey = applying.config.key ?? ""
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error("changed")),
					code: "status_page_conflict",
					message: "changed",
					retryable: false,
				}),
			}),
		).model
		// The older read lands after the conflict started a new one: it must not become the base.
		const stale = pageUpdate(
			refused,
			Message.CompletedFetchConfig({
				key: staleKey,
				result: Result.succeed({ ...base, version: "v6" }),
			}),
		).model
		expect(stale.isRebasingJson).toBe(true)
		expect(stale.jsonBase?.version).toBe("v7")
	})

	test("a failed re-read after a conflict leaves the rebase pending for the next good read", () => {
		const base = { ...statusPageConfig(statusPage(), [component(1), component(2)]), version: "v7" }
		const applying = pageUpdate(
			editing(JSON.stringify(documentOf([1])), { config: base }),
			Message.ClickedApplyJson(),
		).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error("changed")),
					code: "status_page_conflict",
					message: "changed",
					retryable: false,
				}),
			}),
		).model
		const failed = pageUpdate(
			refused,
			Message.CompletedFetchConfig({
				key: refused.config.key ?? "",
				result: Result.fail(toLoadFailure(new Error("unreachable"))),
			}),
		).model
		expect(failed.isRebasingJson).toBe(true)
		expect(failed.jsonBase?.version).toBe("v7")
	})

	test("unsaved Settings edits block Apply until they are saved or discarded", () => {
		const draft = JSON.stringify(documentOf([1]))
		const dirty = pageUpdate(
			editing(draft),
			Message.ChangedSetting({ field: "name", value: "Edited elsewhere" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(dirty),
			expectView(text("Unsaved settings")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
		expect(pageUpdate(dirty, Message.ClickedApplyJson()).commands ?? []).toEqual([])
		const discarded = pageUpdate(dirty, Message.ClickedDiscardSettings()).model
		expect(names(pageUpdate(discarded, Message.ClickedApplyJson()).commands)).toContain(
			"ApplyStatusPageConfig",
		)
	})
})
