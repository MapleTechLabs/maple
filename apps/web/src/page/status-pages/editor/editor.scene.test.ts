import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import {
	StatusPageComponentPublicId,
	type StatusPageConfig,
	StatusPagePublicId,
	type V2StatusPage,
	type V2StatusPageCustomDomain,
} from "@maple/domain/http/v2"
import { DEFAULT_STATUS_PAGE_THEME } from "@maple/domain/status-page"
import { Option, Result, Schema, Array as Arr, String as Str } from "effect"
import {
	all,
	attr,
	change,
	Command,
	click,
	expect as expectView,
	expectAll,
	find,
	given,
	inside,
	Mount,
	role,
	scene,
	selector,
	submit,
	tap,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Dialog from "@maple/views/ui/dialog"
import { MountDialog } from "@maple/views/ui/dialog"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { statusPagesHref } from "../shared/commands"
import { selectionOf } from "../shared/preview"
import { ORG } from "../../kit/alert-test-rows"
import { downMonitor, httpMonitor } from "../../kit/uptime/test-monitors"
import {
	component,
	componentId,
	incident,
	incidentId,
	statusPage,
	statusPageConfig,
} from "../shared/test-pages"
import { PickerMessage } from "../shared/picker"
import {
	CheckCustomDomain,
	FocusEditorElement,
	RemoveCustomDomain,
	SaveVisibility,
	SetCustomDomain,
} from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { moved } from "./update-components"
import { customDomainOf } from "./update-domain"
import { canvasDocument } from "./view-canvas"
import { removeComponentCopy, view as pageView } from "./view"

const ADMIN = Policy.grantsOf(["org:admin"])
const MEMBER = Policy.grantsOf(["org:member"])

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const PUBLIC_ID = Schema.encodeSync(StatusPagePublicId)(statusPage().id)

type Fixture = Readonly<{
	tab?: string
	page?: V2StatusPage
	grants?: ReadonlyArray<Policy.Permission>
	components?: ReturnType<typeof component>[]
	incidents?: ReturnType<typeof incident>[]
	monitorsFail?: boolean
	componentsFail?: boolean
	/** The config read's document; by default the page and its components. */
	config?: StatusPageConfig
	configFail?: boolean
	/** The custom domain read; by default none set on a deployment that offers them. */
	customDomain?: V2StatusPageCustomDomain
}>

/** The custom domain read as the API answers it. */
const customDomain = (fields: Partial<V2StatusPageCustomDomain> = {}): V2StatusPageCustomDomain => ({
	object: "status_page_custom_domain",
	page_id: statusPage().id,
	available: true,
	cname_target: "status-domains.maple.dev",
	hostname: null,
	status: null,
	dns_records: [],
	last_error: null,
	last_checked_at: null,
	activated_at: null,
	created_at: null,
	...fields,
})

const pendingDomain = customDomain({
	hostname: "status.acme.com",
	status: "pending_dns",
	dns_records: [
		{ type: "CNAME", name: "status.acme.com", value: "status-domains.maple.dev", purpose: "routing" },
		{
			type: "TXT",
			name: "_cf-custom-hostname.status.acme.com",
			value: "4d0b9f6e-owner",
			purpose: "ownership",
		},
	],
	last_error: "custom hostname does not CNAME to this zone.",
	created_at: "2026-10-01T12:00:00.000Z",
})

const loaded = (fixture: Fixture = {}): Model => {
	const entered = init(
		{
			_tag: "StatusPage",
			pageId: PUBLIC_ID,
			search: fixture.tab === undefined ? {} : { view: fixture.tab },
		},
		context,
	).model
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12) }),
			Message.CompletedFetchSession({ orgId: ORG, grants: fixture.grants ?? ADMIN }),
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
			Message.CompletedFetchCustomDomain({
				key: entered.customDomain.key ?? "",
				result: Result.succeed(fixture.customDomain ?? customDomain()),
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
												fixture.components ?? [
													component(1),
													component(2),
													component(3),
												],
											),
									),
						}),
					]),
		],
		entered,
		(model, message) => pageUpdate(model, message).model,
	)
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

	test("the preview reads monitor history even when the page lands after the components' debounce", () => {
		const entered = init({ _tag: "StatusPage", pageId: PUBLIC_ID, search: {} }, context).model
		const settle = (model: Model) =>
			pageUpdate(model, Message.ElapsedPreviewDebounce({ generation: model.previewGeneration }))
		const withComponents = pageUpdate(
			entered,
			Message.CompletedFetchComponents({
				key: entered.components.key ?? "",
				result: Result.succeed([component(1)]),
			}),
		).model
		const early = settle(withComponents)
		expect(names(early.commands)).toEqual([])
		const withPage = pageUpdate(
			early.model,
			Message.CompletedFetchPage({ key: entered.page.key ?? "", result: Result.succeed(statusPage()) }),
		)
		expect(names(withPage.commands)).toContain("WaitStatusPageEditorPreview")
		expect(names(settle(withPage.model).commands)).toEqual(["FetchStatusPageEditorPreview"])
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

	test("a component picked in the On this page list opens in its place, and Back returns to the list", () => {
		const target = component(2, { name: "API", group: "Core", manual_status: "degraded" })
		scene(
			{ update: pageUpdate, view },
			given(loaded({ components: [component(1), target] })),
			click(role("button", { name: /^API/u })),
			Command.resolve(FocusEditorElement, Message.CompletedFocus()),
			expectView(role("textbox", { name: "Shown as" })).toHaveValue("API"),
			expectView(role("textbox", { name: "Group" })).toHaveValue("Core"),
			expectView(role("navigation", { name: "On this page" })).not.toExist(),
			click(role("button", { name: "On this page" })),
			Command.resolve(FocusEditorElement, Message.CompletedFocus()),
			expectView(role("button", { name: /^API/u })).toHaveAttr("aria-pressed", "false"),
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

	test("the preview's subscribe dialog carries the Slack command for the page's public address", () => {
		const withDomain = { ...selected(2), publicBaseUrl: "https://status-pr-7.maple.dev" }
		expect(canvasDocument(withDomain, statusPage())).toContain(
			`value="/feed subscribe https://status-pr-7.maple.dev/s/acme-status/feed.rss"`,
		)
		// Slack fetches the feed itself: without a status domain there is no address to give it.
		expect(canvasDocument({ ...withDomain, publicBaseUrl: "" }, statusPage())).not.toContain(
			"/feed subscribe",
		)
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

	test("a description typed in the panel saves on blur and shows in the preview as typed", () => {
		const editing = pageUpdate(
			selected(2),
			Message.ChangedComponentField({ field: "description", value: " Card payments and payouts " }),
		)
		expect(canvasDocument(editing.model, statusPage())).toContain("Card payments and payouts")
		expect(pageUpdate(editing.model, Message.CommittedComponent()).commands).toMatchObject([
			{
				name: "SaveStatusPageComponent",
				args: { componentId: componentId(2), payload: { description: "Card payments and payouts" } },
			},
		])
		scene(
			{ update: pageUpdate, view },
			given(editing.model),
			expectView(role("textbox", { name: "Description" })).toHaveValue(" Card payments and payouts "),
		)
	})

	test("the page's other groups are offered under Group, and picking one saves it at once", () => {
		const rows = [component(1, { group: "Core" }), component(2, { group: "Core" }), component(3)]
		const open = selected(3, { components: rows })
		scene(
			{ update: pageUpdate, view },
			given(open),
			expectView(role("button", { name: "Core" })).toExist(),
		)
		const picked = pageUpdate(open, Message.PickedComponentField({ field: "group", value: "Core" }))
		expect(picked.commands).toMatchObject([
			{ name: "SaveStatusPageComponent", args: { payload: { group: "Core" } } },
		])
		scene(
			{ update: pageUpdate, view },
			given(picked.model),
			expectView(role("textbox", { name: "Group" })).toHaveValue("Core"),
			expectView(role("group", { name: "Groups on this page" })).not.toExist(),
		)
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

	test("Escape saves a typed component edit before closing, since it skips the field's blur", () => {
		const editing = pageUpdate(
			selected(2),
			Message.ChangedComponentField({ field: "name", value: "Payments" }),
		)
		const closed = pageUpdate(editing.model, Message.PressedEscape())
		expect(closed.model.panel).toBeNull()
		expect(names(closed.commands)).toContain("SaveStatusPageComponent")
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
		expect(Arr.map(opened.addPicker.rows, (row) => row.monitorId)).toEqual([monitor.id])
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

	test("a monitor created from a URL goes onto the page at once, unless that Add panel closed meanwhile", () => {
		const monitor = downMonitor()
		const adding = pageUpdate(loaded(), Message.ClickedAddComponent()).model
		const created = Message.CompletedCreateMonitor({
			session: adding.addSession,
			result: Result.succeed(monitor),
		})
		expect(pageUpdate(adding, created).commands).toMatchObject([
			{
				name: "AddStatusPageComponents",
				args: { components: [{ name: monitor.name, monitor_id: monitor.id }] },
			},
			{ name: "TrackStatusPageEditorMonitorCreated", args: { kind: monitor.kind } },
		])
		const closed = pageUpdate(adding, Message.ClickedClosePanel()).model
		expect(names(pageUpdate(closed, created).commands)).not.toContain("AddStatusPageComponents")
		// Reopened before the first monitor arrived: the new panel's picker stays its own.
		const reopened = pageUpdate(closed, Message.ClickedAddComponent()).model
		const late = pageUpdate(reopened, created)
		expect(names(late.commands)).not.toContain("AddStatusPageComponents")
		expect(late.model.addPicker).toEqual(reopened.addPicker)
		// And a late add from the first panel does not close the reopened one.
		const settled = pageUpdate(
			reopened,
			Message.CompletedAddComponents({ session: adding.addSession, result: Result.succeed([]) }),
		)
		expect(settled.model.panel).toEqual(reopened.panel)
	})

	test("the Add panel is locked while a pasted URL is being monitored", () => {
		const adding = pageUpdate(loaded(), Message.ClickedAddComponent()).model
		scene(
			{ update: pageUpdate, view },
			given({ ...adding, addPicker: { ...adding.addPicker, isCreatingMonitor: true } }),
			expectView(role("button", { name: "Add a component without a monitor" })).toBeDisabled(),
			expectView(role("button", { name: "Add component" })).toBeDisabled(),
		)
	})

	test("Add does not reopen while an earlier add is still saving", () => {
		const saving = { ...loaded(), isAddingComponents: true }
		expect(pageUpdate(saving, Message.ClickedAddComponent()).model.panel).toBeNull()
	})

	test("a failed add closes the panel, so a retry cannot add the components that did land twice", () => {
		const adding = pageUpdate(loaded(), Message.ClickedAddComponent()).model
		const failed = pageUpdate(
			{ ...adding, isAddingComponents: true },
			Message.CompletedAddComponents({
				session: adding.addSession,
				result: Result.fail(toLoadFailure(new Error("second create refused"))),
			}),
		)
		expect(failed.model.panel).toBeNull()
		expect(failed.model.isAddingComponents).toBe(false)
		expect(failed.outMessage).toMatchObject({ _tag: "RequestedToast", type: "error" })
	})

	test("members see the page and its components without any control to change them", () => {
		scene(
			{ update: pageUpdate, view },
			given(selected(1, { grants: MEMBER })),
			expectView(text("Component 1")).toExist(),
			expectView(role("button", { name: "Add monitor" })).not.toExist(),
			expectView(role("button", { name: "Move Component 1 down" })).not.toExist(),
			expectView(role("button", { name: "Remove from page" })).not.toExist(),
			expectView(role("textbox", { name: "Shown as" })).toBeDisabled(),
			expectView(text("Only org admins and engineers can change components.")).toExist(),
		)
		expect(
			pageUpdate(selected(1, { grants: MEMBER }), Message.ClickedAddComponent()).model.panel?._tag,
		).toBe("Component")
	})
})

const steps = (model: Model, messages: ReadonlyArray<Message>, ctx: PageContext = context) =>
	Arr.reduce(messages, model, (current, message) => update(current, message, ctx).model)

const mounted = Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog())

/** The reviewed message as the public page's markup renders it. */
const updateBodyOf = find('[role="dialog"] [data-slot="update-body"]')
const messageHtml = (html: Parameters<typeof updateBodyOf>[0]): string =>
	Option.getOrElse(Option.flatMap(updateBodyOf(html), attr("innerHTML")), () => "")

const shown = (row: ReturnType<typeof incident>) =>
	pageUpdate(loaded({ incidents: [row] }), Message.ClickedIncident({ incidentId: row.id })).model

describe("posting an incident", () => {
	test("switching between incident and maintenance keeps what was typed", () => {
		const typed = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "incident" }),
			Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
			Message.ChangedIncidentField({ field: "body", value: "Planned work." }),
		])
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

	test("Post incident opens a dialog on its write step, with the affected components picked", () => {
		const model = loaded({ components: [component(1), component(2, { monitor_id: downMonitor().id })] })
		const opened = pageUpdate(model, Message.ClickedNewIncident({ kind: "incident" })).model
		expect(opened.composeDialog.isOpen).toBe(true)
		expect(opened.incidentForm.impact).toBe("critical")
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			expectView(role("dialog", { name: "Post incident" })).toExist(),
			expectView(role("listitem", { name: "Write" })).toHaveAttr("aria-current", "step"),
			expectView(role("listitem", { name: "Review" })).not.toHaveAttr("aria-current", "step"),
			expectView(role("textbox", { name: "Title" })).toExist(),
			expectView(role("checkbox", { name: "Component 2" })).toBeChecked(),
			expectView(role("checkbox", { name: "Component 1" })).not.toBeChecked(),
		)
	})

	test("Review waits for a title and a message, and names what is missing", () => {
		const opened = pageUpdate(loaded(), Message.ClickedNewIncident({ kind: "incident" })).model
		expect(pageUpdate(opened, Message.SubmittedIncidentWrite()).model.composeStep).toBe("write")
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			expectView(text("Add a title.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
			type(role("textbox", { name: "Title" }), "Elevated API errors"),
			expectView(text("Write the first update.")).toExist(),
			type(role("textbox", { name: "Message" }), "Looking into it."),
			expectView(text("Nothing is public until you confirm on the next step.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeEnabled(),
		)
	})

	const reviewing = () =>
		steps(loaded(), [
			Message.ClickedNewIncident({ kind: "incident" }),
			Message.ChangedIncidentField({ field: "title", value: "Slow checkout" }),
			Message.ChangedIncidentField({ field: "impact", value: "critical" }),
			Message.ToggledIncidentComponent({ componentId: componentId(2) }),
			Message.ChangedIncidentField({ field: "body", value: "**Checkout** is slow." }),
			Message.SubmittedIncidentWrite(),
		])

	test("the review shows the post as the page renders it and what visitors see change", () => {
		const model = reviewing()
		expect(model.composeStep).toBe("review")
		scene(
			{ update: pageUpdate, view },
			given(model),
			mounted,
			expectView(role("dialog", { name: "Review before publishing" })).toExist(),
			inside(
				role("region", { name: "On the page" }),
				expectView(text("Slow checkout")).toExist(),
				expectView(text("Affects Component 2 · Posted just now")).toExist(),
			),
			tap(({ html }) => expect(messageHtml(html)).toBe("<p><strong>Checkout</strong> is slow.</p>")),
			inside(
				role("region", { name: "What changes when you publish" }),
				expectAll(all.role("listitem")).toHaveCount(2),
				expectView(text("Page banner")).toExist(),
				expectView(text("Component 2")).toExist(),
				expectAll(all.text("Major outage")).toHaveCount(2),
				expectView(text("Component 1")).not.toExist(),
			),
		)
	})

	test("Publish creates the incident as reviewed, then the dialog closes on the incident's panel", () => {
		const publishing = pageUpdate(reviewing(), Message.SubmittedIncident({ isPublished: true }))
		expect(publishing.commands).toMatchObject([
			{
				name: "CreateStatusPageIncident",
				args: {
					payload: {
						kind: "incident",
						title: "Slow checkout",
						impact: "critical",
						status: "investigating",
						component_ids: [componentId(2)],
						body: "**Checkout** is slow.",
						published: true,
					},
				},
			},
		])
		expect(
			pageUpdate(publishing.model, Message.SubmittedIncident({ isPublished: true })).commands ?? [],
		).toEqual([])
		const created = pageUpdate(
			publishing.model,
			Message.CompletedCreateIncident({ result: Result.succeed(incident(2)) }),
		)
		expect(created.model.composeDialog.isOpen).toBe(false)
		expect(created.model.panel).toEqual({ _tag: "Incident", incidentId: incidentId(2) })
		expect(names(created.commands)).toContain("FetchStatusPageIncidents")
		expect(created.outMessage).toMatchObject({ _tag: "RequestedToast", title: "Incident published" })
	})

	test("Save as draft sends the same incident unpublished", () => {
		expect(
			pageUpdate(reviewing(), Message.SubmittedIncident({ isPublished: false })).commands,
		).toMatchObject([
			{
				name: "CreateStatusPageIncident",
				args: { payload: { title: "Slow checkout", published: false } },
			},
		])
	})

	test("Back returns to the write step with everything as typed", () => {
		const back = pageUpdate(reviewing(), Message.ClickedIncidentBack()).model
		expect(back.composeStep).toBe("write")
		scene(
			{ update: pageUpdate, view },
			given(back),
			mounted,
			expectView(role("textbox", { name: "Title" })).toHaveValue("Slow checkout"),
			expectView(role("textbox", { name: "Message" })).toHaveValue("**Checkout** is slow."),
			expectView(role("checkbox", { name: "Component 2" })).toBeChecked(),
		)
	})

	test("a refused create stays on the review with the reason", () => {
		const refused = pageUpdate(
			pageUpdate(reviewing(), Message.SubmittedIncident({ isPublished: true })).model,
			Message.CompletedCreateIncident({
				result: Result.fail(toLoadFailure(new Error("create refused"))),
			}),
		).model
		expect(refused.composeDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(refused),
			mounted,
			expectView(text("Couldn't open the incident")).toExist(),
			expectView(role("button", { name: "Publish" })).toBeEnabled(),
		)
	})

	test("the dialog cannot be dismissed while the incident is being created", () => {
		const creating = pageUpdate(reviewing(), Message.SubmittedIncident({ isPublished: true })).model
		const dismissed = pageUpdate(
			creating,
			Message.GotComposeDialogMessage({ message: Dialog.Message.PressedEscape() }),
		).model
		expect(dismissed.composeDialog.isOpen).toBe(true)
	})

	test("maintenance needs a window that ends after it starts, read in the viewer's zone", () => {
		const zoned: PageContext = { ...context, timeZone: "Europe/Berlin" }
		const filled = steps(
			loaded(),
			[
				Message.ClickedNewIncident({ kind: "maintenance" }),
				Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
				Message.ChangedIncidentField({ field: "body", value: "Brief read-only periods." }),
				Message.ChangedIncidentField({ field: "scheduledStart", value: "2026-10-30T22:00" }),
				Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-30T21:00" }),
				Message.SubmittedIncidentWrite(),
			],
			zoned,
		)
		expect(filled.composeStep).toBe("write")
		const fixed = steps(
			filled,
			[
				Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-31T01:00" }),
				Message.SubmittedIncidentWrite(),
			],
			zoned,
		)
		expect(update(fixed, Message.SubmittedIncident({ isPublished: true }), zoned).commands).toMatchObject(
			[
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
			],
		)
	})

	test("future maintenance is scheduled, and changes nothing on the page yet", () => {
		const model = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "maintenance" }),
			Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
			Message.ChangedIncidentField({ field: "body", value: "Brief read-only periods." }),
			Message.ToggledIncidentComponent({ componentId: componentId(1) }),
			Message.ChangedIncidentField({ field: "scheduledStart", value: "2026-10-30T22:00" }),
			Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-30T23:00" }),
			Message.SubmittedIncidentWrite(),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			mounted,
			expectView(text("Nothing on the page changes")).toExist(),
			expectView(role("button", { name: "Schedule" })).toExist(),
		)
	})

	test("an incident can be backdated: the review says when it started and the post carries it", () => {
		const written = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "incident" }),
			Message.ChangedIncidentField({ field: "title", value: "Elevated errors" }),
			Message.ChangedIncidentField({ field: "body", value: "Looking into it." }),
		])
		// The clock reads 12:00: a start after it is refused before Review, as the API would.
		const future = steps(written, [
			Message.ChangedIncidentField({ field: "startedAt", value: "2026-10-01T12:30" }),
			Message.SubmittedIncidentWrite(),
		])
		expect(future.composeStep).toBe("write")
		scene(
			{ update: pageUpdate, view },
			given(future),
			mounted,
			expectView(text("It can't start in the future.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
		const reviewed = steps(future, [
			Message.ChangedIncidentField({ field: "startedAt", value: "2026-10-01T09:05" }),
			Message.SubmittedIncidentWrite(),
		])
		scene(
			{ update: pageUpdate, view },
			given(reviewed),
			mounted,
			inside(
				role("region", { name: "On the page" }),
				expectView(text(/Started Oct 1, 09:05/u)).toExist(),
			),
		)
		expect(pageUpdate(reviewed, Message.SubmittedIncident({ isPublished: true })).commands).toMatchObject(
			[
				{
					name: "CreateStatusPageIncident",
					args: { payload: { started_at: "2026-10-01T09:05:00.000Z" } },
				},
			],
		)
	})

	test("the maintenance review says it starts and completes on its own", () => {
		const reviewed = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "maintenance" }),
			Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
			Message.ChangedIncidentField({ field: "body", value: "Brief read-only periods." }),
			Message.ChangedIncidentField({ field: "scheduledStart", value: "2026-10-30T22:00" }),
			Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-31T01:00" }),
			Message.SubmittedIncidentWrite(),
		])
		scene(
			{ update: pageUpdate, view },
			given(reviewed),
			mounted,
			inside(
				role("region", { name: "Schedule" }),
				expectView(
					text(
						"Starts Oct 30, 22:00 and ends Oct 31, 01:00 (UTC). It moves to In progress at the start and to Completed at the end on its own; subscribers see both updates.",
					),
				).toExist(),
			),
		)
	})

	test("a first update over 20,000 characters keeps Review shut and says so", () => {
		const long = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "incident" }),
			Message.ChangedIncidentField({ field: "title", value: "Elevated errors" }),
			Message.ChangedIncidentField({ field: "body", value: Str.repeat(20_001)("x") }),
		])
		expect(pageUpdate(long, Message.SubmittedIncidentWrite()).model.composeStep).toBe("write")
		scene(
			{ update: pageUpdate, view },
			given(long),
			mounted,
			expectAll(all.text("Keep it under 20,000 characters (20,001 now).")).toHaveCount(2),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
	})

	test("the write step lists what is missing for maintenance", () => {
		const opened = pageUpdate(loaded(), Message.ClickedNewIncident({ kind: "maintenance" })).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			type(role("textbox", { name: "Title" }), "Database upgrade"),
			type(role("textbox", { name: "Message" }), "Brief read-only periods."),
			expectView(text("Set when the maintenance starts and ends.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
	})
})

describe("posting an update", () => {
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
		)
		expect(
			pageUpdate(model, Message.ClickedPublishIncident({ incidentId: incidentId(1) })).commands,
		).toMatchObject([{ name: "PublishStatusPageIncident", args: { incidentId: incidentId(1) } }])
	})

	test("Post update opens a dialog with the status one step along, and Review needs a message", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1, { status: "identified" })] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
		).model
		expect(opened.updateDialog.isOpen).toBe(true)
		expect(opened.updateForm).toMatchObject({ _tag: "Writing", form: { status: "monitoring" } })
		expect(pageUpdate(opened, Message.SubmittedUpdateWrite()).model.updateForm._tag).toBe("Writing")
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			expectView(role("dialog", { name: "Post update" })).toExist(),
			// The last update reads as the page renders it.
			tap(({ html }) =>
				expect(messageHtml(html)).toBe("<p>We are looking into elevated error rates.</p>"),
			),
			expectView(role("button", { name: "Monitoring" })).toHaveAttr("aria-pressed", "true"),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
			type(role("textbox", { name: "Message" }), "A fix is rolling out."),
			expectView(role("button", { name: "Review" })).toBeEnabled(),
		)
	})

	const resolving = () =>
		steps(loaded({ incidents: [incident(1, { impact: "major" })] }), [
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
			Message.SubmittedUpdateWrite(),
		])

	test("resolving reviews the components going back to operational, then posts the closing message", () => {
		const model = resolving()
		scene(
			{ update: pageUpdate, view },
			given(model),
			mounted,
			inside(role("region", { name: "On the page" }), expectView(text("Resolved")).toExist()),
			tap(({ html }) => expect(messageHtml(html)).toBe("<p>This incident has been resolved.</p>")),
			inside(
				role("region", { name: "What changes" }),
				expectAll(all.role("listitem")).toHaveCount(2),
				expectView(text("Page banner")).toExist(),
				expectView(text("Component 1")).toExist(),
				expectAll(all.text("Partial outage")).toHaveCount(2),
			),
		)
		const posting = pageUpdate(model, Message.SubmittedUpdate())
		expect(posting.commands).toMatchObject([
			{
				name: "PostStatusPageIncidentUpdate",
				args: {
					incidentId: incidentId(1),
					payload: { status: "resolved", body: "This incident has been resolved." },
				},
			},
		])
		const posted = pageUpdate(
			posting.model,
			Message.CompletedPostUpdate({ result: Result.succeed(incident(1, { status: "resolved" })) }),
		)
		expect(posted.model.updateDialog.isOpen).toBe(false)
		expect(posted.outMessage).toMatchObject({ _tag: "RequestedToast", title: "Incident resolved" })
	})

	test("a typed time re-reads the clock, so it is checked against the time it was typed", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1)] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
		).model
		const typed = pageUpdate(
			opened,
			Message.ChangedUpdateField({ field: "endedAt", value: "2026-10-01T11:58" }),
		)
		expect(names(typed.commands)).toEqual(["ReadStatusPageClock"])
	})

	test("resolving can say when it ended, but not in the future", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1)] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
		).model
		const late = steps(opened, [
			Message.ChangedUpdateField({ field: "endedAt", value: "2026-10-01T12:30" }),
			Message.SubmittedUpdateWrite(),
		])
		expect(late.updateForm._tag).toBe("Writing")
		scene(
			{ update: pageUpdate, view },
			given(late),
			mounted,
			expectView(text("It can't end in the future.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
		// A clock read after the typed minute lets it through.
		const later = steps(late, [
			Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12, 31) }),
			Message.SubmittedUpdateWrite(),
		])
		expect(later.updateForm._tag).toBe("Reviewing")
	})

	test("resolving can say when it ended, but not before the incident started", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1)] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
		).model
		const early = steps(opened, [
			Message.ChangedUpdateField({ field: "endedAt", value: "2026-10-01T11:45" }),
			Message.SubmittedUpdateWrite(),
		])
		expect(early.updateForm._tag).toBe("Writing")
		scene(
			{ update: pageUpdate, view },
			given(early),
			mounted,
			expectView(text("It can't end before it started.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
		const reviewed = steps(early, [
			Message.ChangedUpdateField({ field: "endedAt", value: "2026-10-01T11:58" }),
			Message.SubmittedUpdateWrite(),
		])
		expect(pageUpdate(reviewed, Message.SubmittedUpdate()).commands).toMatchObject([
			{
				name: "PostStatusPageIncidentUpdate",
				args: { payload: { status: "resolved", resolved_at: "2026-10-01T11:58:00.000Z" } },
			},
		])
	})

	test("an update that does not close the incident has no end time to set", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1)] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			expectView(role("textbox", { name: "Ended" })).not.toExist(),
		)
	})

	test("Back keeps the message, and a failed post stays on the review with the reason", () => {
		const back = pageUpdate(resolving(), Message.ClickedUpdateBack()).model
		expect(back.updateForm).toMatchObject({
			_tag: "Writing",
			form: { status: "resolved", body: "This incident has been resolved." },
		})
		const failed = steps(back, [
			Message.SubmittedUpdateWrite(),
			Message.SubmittedUpdate(),
			Message.CompletedPostUpdate({ result: Result.fail(toLoadFailure(new Error("unreachable"))) }),
		])
		expect(failed.updateDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			mounted,
			expectView(text("Couldn't post the update")).toExist(),
			expectView(role("button", { name: "Publish update" })).toBeEnabled(),
		)
	})

	test("Change title, impact, times or components opens Edit details over the update, which keeps its message", () => {
		const typed = steps(loaded({ incidents: [incident(1, { title: "Elevated errors" })] }), [
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
			Message.ChangedUpdateField({ field: "body", value: "Still looking." }),
		])
		const editing = pageUpdate(typed, Message.ClickedEditIncident({ incidentId: incidentId(1) })).model
		expect(editing.editIncidentDialog.isOpen).toBe(true)
		expect(editing.updateDialog.isOpen).toBe(true)
		expect(editing.updateForm).toMatchObject({ _tag: "Writing", form: { body: "Still looking." } })
		scene(
			{ update: pageUpdate, view },
			given(typed),
			mounted,
			expectView(role("button", { name: "Change title, impact, times or components" })).toHaveHandler(
				"click",
			),
		)
		scene(
			{ update: pageUpdate, view },
			given(editing),
			mounted,
			mounted,
			expectView(role("dialog", { name: "Post update" })).toExist(),
			expectView(role("dialog", { name: "Edit details" })).toExist(),
			expectView(role("textbox", { name: "Title" })).toHaveValue("Elevated errors"),
		)
	})
})

describe("editing an incident's details", () => {
	test("Edit details opens the saved title, impact and components in a dialog", () => {
		const opened = pageUpdate(
			shown(incident(1, { title: "Elevated errors" })),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		expect(opened.editIncidentDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			expectView(role("textbox", { name: "Title" })).toHaveValue("Elevated errors"),
			expectView(role("checkbox", { name: "Component 1" })).toBeChecked(),
			expectView(role("checkbox", { name: "Component 2" })).not.toBeChecked(),
		)
	})

	test("saving an edit sends the trimmed title, the impact and the components once, and posts no update", () => {
		const edited = steps(shown(incident(1)), [
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
			Message.ChangedIncidentEditField({ field: "title", value: " Checkout errors " }),
			Message.ChangedIncidentEditField({ field: "impact", value: "critical" }),
			Message.ToggledIncidentEditComponent({ componentId: componentId(2) }),
		])
		const saving = pageUpdate(edited, Message.SubmittedIncidentEdit())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveStatusPageIncident",
				args: {
					incidentId: incidentId(1),
					payload: {
						title: "Checkout errors",
						impact: "critical",
						component_ids: [componentId(1), componentId(2)],
					},
				},
			},
		])
		expect(pageUpdate(saving.model, Message.SubmittedIncidentEdit()).commands ?? []).toEqual([])
		const saved = pageUpdate(
			saving.model,
			Message.CompletedSaveIncident({
				result: Result.succeed(incident(1, { title: "Checkout errors", impact: "critical" })),
			}),
		)
		expect(saved.model.editIncidentDialog.isOpen).toBe(false)
		expect(names(saved.commands)).not.toContain("PostStatusPageIncidentUpdate")
		expect(saved.outMessage).toMatchObject({ _tag: "RequestedToast", type: "success" })
	})

	test("an edit with no title is not sent, and a refused save keeps what was typed with the reason", () => {
		const opened = pageUpdate(
			shown(incident(1)),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		const blank = pageUpdate(
			opened,
			Message.ChangedIncidentEditField({ field: "title", value: "  " }),
		).model
		expect(pageUpdate(blank, Message.SubmittedIncidentEdit()).commands ?? []).toEqual([])
		const refused = steps(opened, [
			Message.ChangedIncidentEditField({ field: "title", value: "Checkout errors" }),
			Message.SubmittedIncidentEdit(),
			Message.CompletedSaveIncident({ result: Result.fail(toLoadFailure(new Error("save refused"))) }),
		])
		expect(refused.incidentEdit?.title).toBe("Checkout errors")
		expect(refused.editIncidentDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(refused),
			mounted,
			expectView(text("Couldn't save the changes")).toExist(),
			expectView(role("button", { name: "Save changes" })).toBeEnabled(),
		)
	})

	test("maintenance has no impact to edit, so its save sends none", () => {
		const opened = pageUpdate(
			shown(
				incident(1, {
					kind: "maintenance",
					status: "scheduled",
					impact: "none",
					scheduled_start: "1970-01-01T01:10:00.000Z",
					scheduled_end: "1970-01-01T02:10:00.000Z",
				}),
			),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			expectView(role("textbox", { name: "Title" })).toExist(),
			expectView(role("combobox", { name: "Impact" })).not.toExist(),
		)
		const sent = pageUpdate(opened, Message.SubmittedIncidentEdit()).commands ?? []
		expect(sent).toMatchObject([{ name: "SaveStatusPageIncident" }])
		expect(sent[0]?.args?.payload).not.toHaveProperty("impact")
	})

	const maintenance = incident(1, {
		kind: "maintenance",
		status: "scheduled",
		impact: "none",
		scheduled_start: "1970-01-01T01:10:00.000Z",
		scheduled_end: "1970-01-01T02:10:00.000Z",
	})

	test("a maintenance window is edited in the viewer's zone, sending only the bound that changed", () => {
		const zoned: PageContext = { ...context, timeZone: "Europe/Berlin" }
		const opened = update(
			shown(maintenance),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
			zoned,
		).model
		expect(opened.incidentEdit).toMatchObject({ start: "1970-01-01T02:10", end: "1970-01-01T03:10" })
		const inverted = steps(
			opened,
			[Message.ChangedIncidentEditField({ field: "end", value: "1970-01-01T02:00" })],
			zoned,
		)
		expect(update(inverted, Message.SubmittedIncidentEdit(), zoned).commands ?? []).toEqual([])
		const extended = steps(
			inverted,
			[Message.ChangedIncidentEditField({ field: "end", value: "1970-01-01T04:00" })],
			zoned,
		)
		const sent = update(extended, Message.SubmittedIncidentEdit(), zoned).commands ?? []
		expect(sent[0]?.args?.payload).toMatchObject({ scheduled_end: "1970-01-01T03:00:00.000Z" })
		expect(sent[0]?.args?.payload).not.toHaveProperty("scheduled_start")
	})

	test("completed maintenance offers no window to edit", () => {
		const opened = pageUpdate(
			shown({ ...maintenance, status: "completed", resolved_at: "1970-01-01T02:10:00.000Z" }),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			expectView(role("textbox", { name: "Starts" })).not.toExist(),
			expectView(role("textbox", { name: "Ends" })).not.toExist(),
		)
	})

	test("an incident's start and end can't move into the future", () => {
		const opened = pageUpdate(
			shown(incident(1, { status: "resolved", resolved_at: "2026-10-01T11:55:00.000Z" })),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		const lateEnd = pageUpdate(
			opened,
			Message.ChangedIncidentEditField({ field: "end", value: "2026-10-01T12:30" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(lateEnd),
			mounted,
			expectView(text("It can't end in the future.")).toExist(),
			expectView(role("button", { name: "Save changes" })).toBeDisabled(),
		)
		expect(pageUpdate(lateEnd, Message.SubmittedIncidentEdit()).commands ?? []).toEqual([])
		const lateStart = pageUpdate(
			opened,
			Message.ChangedIncidentEditField({ field: "start", value: "2026-10-02T09:00" }),
		).model
		expect(pageUpdate(lateStart, Message.SubmittedIncidentEdit()).commands ?? []).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(lateStart),
			mounted,
			expectView(text("It can't start in the future.")).toExist(),
		)
	})

	test("a resolved incident's start and end can be corrected, but not out of order", () => {
		const opened = pageUpdate(
			shown(incident(1, { status: "resolved", resolved_at: "2026-10-01T11:55:00.000Z" })),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		const inverted = pageUpdate(
			opened,
			Message.ChangedIncidentEditField({ field: "start", value: "2026-10-01T11:57" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(inverted),
			mounted,
			expectView(text("It can't end before it started.")).toExist(),
			expectView(role("button", { name: "Save changes" })).toBeDisabled(),
		)
		const corrected = pageUpdate(
			inverted,
			Message.ChangedIncidentEditField({ field: "start", value: "2026-10-01T11:40" }),
		).model
		const sent = pageUpdate(corrected, Message.SubmittedIncidentEdit()).commands ?? []
		expect(sent[0]?.args?.payload).toMatchObject({ started_at: "2026-10-01T11:40:00.000Z" })
		expect(sent[0]?.args?.payload).not.toHaveProperty("resolved_at")
	})
})

describe("deleting an incident", () => {
	test("deleting an incident asks first, deletes it once and closes its panel", () => {
		const asking = pageUpdate(
			shown(incident(1, { status: "resolved" })),
			Message.ClickedDeleteIncident({ incidentId: incidentId(1) }),
		)
		expect(asking.model.confirmDeleteIncidentId).toBe(incidentId(1))
		expect(asking.model.deleteIncidentDialog.isOpen).toBe(true)
		expect(names(asking.commands)).not.toContain("DeleteStatusPageIncident")
		const deleting = pageUpdate(asking.model, Message.ClickedConfirmDeleteIncident())
		expect(deleting.commands).toMatchObject([
			{ name: "DeleteStatusPageIncident", args: { incidentId: incidentId(1) } },
		])
		expect(pageUpdate(deleting.model, Message.ClickedConfirmDeleteIncident()).commands ?? []).toEqual([])
		const deleted = pageUpdate(
			deleting.model,
			Message.CompletedDeleteIncident({ result: Result.succeed(undefined) }),
		)
		expect(deleted.model.panel).toBeNull()
		expect(deleted.model.deleteIncidentDialog.isOpen).toBe(false)
		expect(names(deleted.commands)).toContain("FetchStatusPageIncidents")
	})

	test("a delete that fails leaves the incident open in the panel and says why", () => {
		const deleting = pageUpdate(
			pageUpdate(shown(incident(1)), Message.ClickedDeleteIncident({ incidentId: incidentId(1) }))
				.model,
			Message.ClickedConfirmDeleteIncident(),
		).model
		const failed = pageUpdate(
			deleting,
			Message.CompletedDeleteIncident({
				result: Result.fail(toLoadFailure(new Error("delete refused"))),
			}),
		)
		expect(failed.model.panel).toEqual({ _tag: "Incident", incidentId: incidentId(1) })
		expect(failed.model.isDeletingIncident).toBe(false)
		expect(failed.outMessage).toMatchObject({ _tag: "RequestedToast", type: "error" })
	})
})

describe("an update in flight", () => {
	const posting = () =>
		steps(
			loaded({
				incidents: [incident(1, { status: "identified" }), incident(2, { status: "identified" })],
			}),
			[
				Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
				Message.ChangedUpdateField({ field: "body", value: "Fixed." }),
				Message.SubmittedUpdateWrite(),
				Message.SubmittedUpdate(),
			],
		)

	test("edits, closing and another incident's Post update wait, and a failure keeps the text", () => {
		const held = steps(posting(), [
			Message.ChangedUpdateField({ field: "body", value: "Other" }),
			Message.ClickedUpdateBack(),
			Message.GotUpdateDialogMessage({ message: Dialog.Message.ClickedClose() }),
			Message.ClickedPostUpdate({ incidentId: incidentId(2), isResolving: false }),
		])
		expect(held.updateDialog.isOpen).toBe(true)
		expect(held.updateForm).toMatchObject({
			_tag: "Posting",
			form: { incidentId: incidentId(1), body: "Fixed." },
		})
		const failed = pageUpdate(
			held,
			Message.CompletedPostUpdate({ result: Result.fail(toLoadFailure(new Error("unreachable"))) }),
		).model
		expect(failed.updateForm).toMatchObject({ _tag: "Failed", form: { body: "Fixed." } })
	})

	test("a success closes the dialog and reads the incidents again", () => {
		const done = pageUpdate(
			posting(),
			Message.CompletedPostUpdate({ result: Result.succeed(incident(1)) }),
		)
		expect(done.model.updateDialog.isOpen).toBe(false)
		expect(names(done.commands)).toContain("FetchStatusPageIncidents")
		expect(done.outMessage).toMatchObject({ _tag: "RequestedToast", type: "success" })
	})
})

describe("header", () => {
	test("Post incident is offered on the Page tab, whose panel shows the posted incident", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(role("button", { name: "Post incident" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "appearance" })),
			expectView(role("button", { name: "Post incident" })).not.toExist(),
			expectView(role("link", { name: "Appearance" })).toHaveAttr("aria-current", "page"),
		)
	})

	test("Open page opens the published page in a new tab", () => {
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded({ tab: "settings" }), publicBaseUrl: "https://status-pr-7.maple.dev" }),
			expectView(role("link", { name: "Open page" })).toHaveAttr(
				"href",
				"https://status-pr-7.maple.dev/s/acme-status",
			),
			expectView(role("link", { name: "Open page" })).toHaveAttr("target", "_blank"),
			expectView(role("link", { name: "Open page" })).toHaveAttr("rel", "noopener"),
		)
	})

	test("Open page is disabled, with the reason, while the page has no public address", () => {
		scene(
			{ update: pageUpdate, view },
			given({
				...loaded({ page: statusPage({ draft: true, published_at: null }) }),
				publicBaseUrl: "https://status-pr-7.maple.dev",
			}),
			expectView(role("link", { name: "Open page" })).not.toExist(),
			expectView(role("button", { name: "Open page" })).toBeDisabled(),
			expectView(selector('[data-tooltip="Publish the page to open it"]')).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded(), publicBaseUrl: "" }),
			expectView(role("link", { name: "Open page" })).not.toExist(),
			expectView(role("button", { name: "Open page" })).toBeDisabled(),
			expectView(selector('[data-tooltip="No status domain is configured yet"]')).toExist(),
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
			expectView(text("This page is a draft")).toExist(),
			expectView(role("button", { name: "Publish page" })).toExist(),
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

	test("a draft reached by link says it is not public, not that it is live", () => {
		scene(
			{ update: pageUpdate, view },
			given({
				...loaded({ tab: "live", page: statusPage({ draft: true }) }),
				publicBaseUrl: "https://status-pr-7.maple.dev",
			}),
			expectView(role("heading", { name: "Acme Status is not public yet" })).toExist(),
			expectView(role("heading", { name: "Acme Status is live" })).not.toExist(),
			// The publisher skips a draft, so its address would not resolve: no link to open.
			expectView(role("link", { name: "Open" })).not.toExist(),
			expectView(role("link", { name: "https://status-pr-7.maple.dev/s/acme-status" })).not.toExist(),
		)
	})

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

	test("an internal page is live for members in Maple: no public address and no break-glass token", () => {
		scene(
			{ update: pageUpdate, view },
			given({
				...loaded({ tab: "live", page: statusPage({ visibility: "internal" }) }),
				publicBaseUrl: "https://status-pr-7.maple.dev",
			}),
			expectView(role("heading", { name: "Acme Status is live" })).toExist(),
			expectView(text("Only members of this organization can read it, in Maple.")).toExist(),
			expectView(text(/Visitors can read it now/u)).not.toExist(),
			expectView(selector("#status-page-public-url")).not.toExist(),
			expectView(role("link", { name: /\/s\/acme-status/u })).not.toExist(),
			expectAll(all.role("link", { name: "Open page" })).toHaveCount(2),
			expectView(role("link", { name: "Open page" })).toHaveAttr(
				"href",
				`/status-pages/${PUBLIC_ID}/view`,
			),
			expectView(role("button", { name: "Get break-glass token" })).not.toExist(),
		)
	})

	test("an engineer edits the page but cannot issue a break-glass token", () => {
		const engineer = {
			...live("https://status-pr-7.maple.dev"),
			grants: Policy.grantsOf(["org:engineer"]),
		}
		scene(
			{ update: pageUpdate, view },
			given(engineer),
			expectView(role("button", { name: "Get break-glass token" })).not.toExist(),
		)
		expect(names(pageUpdate(engineer, Message.ClickedRotateToken()).commands)).toEqual([])
	})

	test("Get break-glass token issues one at once and shows it once", () => {
		const issuing = pageUpdate(loaded({ tab: "live" }), Message.ClickedRotateToken())
		expect(names(issuing.commands)).toEqual(["RotateStatusPageBreakGlassToken"])
	})
})

describe("settings and appearance views", () => {
	test("an edit raises the save bar, and a bad color blocks the save", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "appearance" })),
			expectView(text("Unsaved changes")).not.toExist(),
			type(role("textbox", { name: "Accent" }), "teal"),
			expectView(text("Unsaved changes")).toExist(),
			expectView(text("Use a hex color like #1a2b3c.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("a bad field on Settings blocks the save on Appearance too, and the bar names its tab", () => {
		const edited = pageUpdate(
			loaded({ tab: "settings" }),
			Message.ChangedSetting({ field: "termsUrl", value: "http://acme.example/terms" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given({ ...edited, search: { view: "appearance" } }),
			expectView(text("Fix the fields marked on the Settings tab.")).toExist(),
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
		const edited = Arr.reduce(
			[
				Message.ChangedThemeColor({ field: "accent", value: "#1A2B3C" }),
				Message.PickedThemePreset({ preset: "paper" }),
				Message.ChangedSetting({ field: "autoIncidents", value: "publish" }),
				Message.ToggledPoweredBy(),
				Message.ChangedSetting({ field: "privacyUrl", value: " https://acme.example/privacy " }),
			],
			loaded({ tab: "settings" }),
			(model, message) => pageUpdate(model, message).model,
		)
		const saving = pageUpdate(edited, Message.ClickedSaveSettings())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveStatusPageSettings",
				args: {
					payload: {
						name: "Acme Status",
						slug: "acme-status",
						theme: {
							...DEFAULT_STATUS_PAGE_THEME,
							preset: "paper",
							font: "serif",
							radius: "sm",
							accent: "#1a2b3c",
						},
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
			theme: {
				...DEFAULT_STATUS_PAGE_THEME,
				preset: "paper",
				font: "serif",
				radius: "sm",
				accent: "#1a2b3c",
			},
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
			given(loaded({ tab: "appearance" })),
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
			given(loaded({ tab: "appearance" })),
			inside(role("group", { name: "Mode" }), click(role("button", { name: "Light" }))),
			type(role("textbox", { name: "Text" }), "#757575"),
			expectView(
				text("Text on the background has a contrast of 4.49:1; it needs at least 4.5:1."),
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
			given(loaded({ tab: "appearance" })),
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

	test("the branding links preview at once: the dark logo in dark mode and the favicon", () => {
		const iframeOf = find("iframe")
		const srcdoc = (html: Parameters<typeof iframeOf>[0]): string =>
			Option.getOrElse(Option.flatMap(iframeOf(html), attr("srcdoc")), () => "")
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "appearance" })),
			type(role("textbox", { name: "Logo URL" }), "https://acme.example/logo.svg"),
			type(role("textbox", { name: "Dark mode logo URL" }), "https://acme.example/logo-dark.svg"),
			type(role("textbox", { name: "Favicon URL" }), "https://acme.example/favicon.png"),
			tap(({ html }) => {
				expect(srcdoc(html)).toContain(`<img src="https://acme.example/logo.svg"`)
				expect(srcdoc(html)).toContain(`<link rel="icon" href="https://acme.example/favicon.png">`)
			}),
			inside(role("group", { name: "Preview mode" }), click(role("button", { name: "Dark" }))),
			tap(({ html }) =>
				expect(srcdoc(html)).toContain(`<img src="https://acme.example/logo-dark.svg"`),
			),
		)
	})

	test("a bad branding link is marked on Appearance, and the Settings save bar points there", () => {
		const edited = pageUpdate(
			loaded({ tab: "appearance" }),
			Message.ChangedSetting({ field: "faviconUrl", value: "http://acme.example/favicon.png" }),
		).model
		scene({ update: pageUpdate, view }, given(edited), expectView(text("Use an https URL.")).toExist())
		scene(
			{ update: pageUpdate, view },
			given({ ...edited, search: { view: "settings" } }),
			expectView(text("Fix the fields marked on the Appearance tab.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("the preview can show a state the page is not in, and says it is an example", () => {
		const iframeOf = find("iframe")
		const srcdoc = (html: Parameters<typeof iframeOf>[0]): string =>
			Option.getOrElse(Option.flatMap(iframeOf(html), attr("srcdoc")), () => "")
		const note = text("Showing an example state. Visitors still see the live page.")
		const pick = (name: string) =>
			inside(role("group", { name: "Preview state" }), click(role("button", { name })))
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "appearance" })),
			expectView(note).not.toExist(),
			tap(({ html }) => expect(srcdoc(html)).not.toContain("Example incident")),
			pick("Outage"),
			tap(({ html }) => expect(srcdoc(html)).toContain("Example incident")),
			expectView(note).toExist(),
			// Looking only: the example is not a page edit and posts nothing.
			expectView(text("Unsaved changes")).not.toExist(),
			pick("Maintenance"),
			tap(({ html }) => {
				expect(srcdoc(html)).toContain("Example maintenance")
				expect(srcdoc(html)).not.toContain("Example incident")
			}),
			pick("All clear"),
			tap(({ html }) => expect(srcdoc(html)).not.toContain("Example maintenance")),
			expectView(note).toExist(),
			pick("Live"),
			expectView(note).not.toExist(),
		)
	})

	test("the preview narrows to a phone and back", () => {
		const pick = (name: string) =>
			inside(role("group", { name: "Preview width" }), click(role("button", { name })))
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "appearance" })),
			expectView(selector("iframe")).toHaveAttr("data-width", "desktop"),
			pick("Mobile"),
			expectView(selector("iframe")).toHaveAttr("data-width", "mobile"),
			expectView(text("Unsaved changes")).not.toExist(),
			pick("Desktop"),
			expectView(selector("iframe")).toHaveAttr("data-width", "desktop"),
		)
	})

	test("each color has a picker that opens on the color in effect", () => {
		const accent = selector('[aria-label="Accent color"]')
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "appearance" })),
			// Empty field: the preset's own colour, the one the placeholder names.
			expectView(accent).toHaveValue("#000000"),
			type(role("textbox", { name: "Accent" }), "#FF0066"),
			expectView(accent).toHaveValue("#ff0066"),
			// A colour input cannot hold something that is not a hex colour.
			type(role("textbox", { name: "Accent" }), "teal"),
			expectView(accent).not.toExist(),
			// Auto takes the overrides from the preset, so they have nothing to pick.
			expectView(selector('[aria-label="Background color"]')).not.toExist(),
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

	test("a password is set before the page can be password-protected, and never rides a command's args", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings" })),
			expectView(role("radio", { name: "Password-protected" })).toBeDisabled(),
			expectView(text("Set a password below first.")).toExist(),
			click(role("button", { name: "Set password" })),
			type(role("textbox", { name: "New password" }), "short"),
			expectView(text("Use at least 8 characters")).toExist(),
			expectView(role("button", { name: "Save password" })).toBeDisabled(),
		)
		const typed = pageUpdate(
			pageUpdate(loaded({ tab: "settings" }), Message.ClickedChangePassword()).model,
			Message.ChangedPassword({ value: "correct horse battery" }),
		).model
		const saving = pageUpdate(typed, Message.SubmittedPassword())
		expect(saving.commands).toMatchObject([{ name: "SetStatusPagePassword" }])
		expect(saving.commands?.[0]).not.toHaveProperty("args")
		const saved = pageUpdate(
			saving.model,
			Message.CompletedAccessChange({
				action: "password",
				result: Result.succeed(statusPage({ has_password: true })),
			}),
		).model
		expect(saved.passwordDraft).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(saved),
			expectView(role("radio", { name: "Password-protected" })).not.toBeDisabled(),
			change(role("radio", { name: "Password-protected" }), "on"),
			Command.resolve(
				SaveVisibility,
				Message.CompletedAccessChange({
					action: "visibility",
					result: Result.succeed(statusPage({ has_password: true, visibility: "password" })),
				}),
			),
			// A password page keeps its password: it can be changed, not removed.
			expectView(role("button", { name: "Change password" })).toExist(),
			expectView(role("button", { name: "Remove password" })).not.toExist(),
		)
	})

	test("a page with a custom domain cannot go internal, and only admins change who can view", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings", customDomain: pendingDomain })),
			expectView(role("radio", { name: "Internal" })).toBeDisabled(),
			expectView(text("Remove the custom domain first.")).toExist(),
		)
		const engineer = loaded({ tab: "settings", grants: Policy.grantsOf(["org:engineer"]) })
		scene(
			{ update: pageUpdate, view },
			given(engineer),
			expectView(text("Only org admins can change who can view a status page.")).toExist(),
			expectView(role("button", { name: "Set password" })).not.toExist(),
		)
		expect(
			names(pageUpdate(engineer, Message.PickedVisibility({ visibility: "internal" })).commands),
		).toEqual([])
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

describe("custom domain", () => {
	test("adding a domain sends the hostname as typed, normalized, then shows the DNS records to add", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings" })),
			expectView(role("button", { name: "Add domain" })).toBeDisabled(),
			type(role("textbox", { name: "Hostname" }), " Status.Acme.com "),
			submit(role("form", { name: "Custom domain" })),
			Command.expectExact(SetCustomDomain({ pageId: statusPage().id, hostname: "status.acme.com" })),
			Command.resolve(
				SetCustomDomain,
				Message.CompletedSetCustomDomain({ result: Result.succeed(pendingDomain) }),
			),
			expectView(text("Waiting for DNS")).toExist(),
			expectView(text("status-domains.maple.dev")).toExist(),
			expectView(text("_cf-custom-hostname.status.acme.com")).toExist(),
			expectView(text("custom hostname does not CNAME to this zone.")).toExist(),
			expectView(role("button", { name: "Copy ownership TXT value" })).toExist(),
			expectView(role("button", { name: "Check now" })).toExist(),
		)
	})

	test("an apex, an IP or a Maple hostname is refused before it is sent", () => {
		for (const hostname of ["acme.com", "10.0.0.1", "status.maple.dev"])
			scene(
				{ update: pageUpdate, view },
				given(loaded({ tab: "settings" })),
				type(role("textbox", { name: "Hostname" }), hostname),
				expectView(role("button", { name: "Add domain" })).toBeDisabled(),
				expectView(role("textbox", { name: "Hostname" })).toHaveAttr("aria-invalid", "true"),
			)
	})

	test("Check now asks Cloudflare again and an active domain becomes the page's address", () => {
		const checking = pageUpdate(
			loaded({ tab: "settings", customDomain: pendingDomain }),
			Message.ClickedCheckCustomDomain(),
		)
		expect(checking.commands).toMatchObject([
			{ name: CheckCustomDomain.name, args: { pageId: statusPage().id } },
		])
		const active = customDomain({
			hostname: "status.acme.com",
			status: "active",
			dns_records: [pendingDomain.dns_records[0]!],
		})
		const done = pageUpdate(
			checking.model,
			Message.CompletedCheckCustomDomain({ result: Result.succeed(active) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(done),
			expectView(text("Active")).toExist(),
			expectView(role("link", { name: "https://status.acme.com" })).toHaveAttr(
				"href",
				"https://status.acme.com",
			),
		)
	})

	test("a failed domain says what went wrong", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				loaded({
					tab: "settings",
					customDomain: customDomain({
						hostname: "status.acme.com",
						status: "failed",
						last_error: "The hostname no longer points at Maple. Check its CNAME record.",
					}),
				}),
			),
			expectView(text("Needs attention")).toExist(),
			expectView(text("The hostname no longer points at Maple. Check its CNAME record.")).toExist(),
		)
	})

	test("removing the domain asks first, then removes it once", () => {
		const asking = pageUpdate(
			loaded({ tab: "settings", customDomain: pendingDomain }),
			Message.ClickedRemoveCustomDomain(),
		)
		expect(asking.model.removeCustomDomainDialog.isOpen).toBe(true)
		expect(names(asking.commands)).not.toContain(RemoveCustomDomain.name)
		const removing = pageUpdate(asking.model, Message.ClickedConfirmRemoveCustomDomain())
		expect(removing.commands).toMatchObject([
			{ name: RemoveCustomDomain.name, args: { pageId: statusPage().id } },
		])
		// A second confirm while the first is in flight sends nothing.
		expect(pageUpdate(removing.model, Message.ClickedConfirmRemoveCustomDomain()).commands ?? []).toEqual(
			[],
		)
		// An earlier refused hostname is not shown against the now-empty field.
		const refused = pageUpdate(
			{ ...removing.model, customDomainAction: "set" },
			Message.CompletedSetCustomDomain({ result: Result.fail(toLoadFailure(new Error("taken"))) }),
		).model
		const removed = pageUpdate(
			{ ...refused, customDomainAction: "remove" },
			Message.CompletedRemoveCustomDomain({ result: Result.succeed(customDomain()) }),
		)
		expect(removed.model.customDomainFailure).toBeNull()
		expect(removed.model.removeCustomDomainDialog.isOpen).toBe(false)
		expect(removed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Custom domain removed",
				description: "",
			}),
		)
		expect(Option.getOrNull(customDomainOf(removed.model))?.hostname).toBeNull()
	})

	test("an internal page takes no custom domain, and has no break-glass token to issue", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings", page: statusPage({ visibility: "internal" }) })),
			expectView(role("textbox", { name: "Hostname" })).toBeDisabled(),
			expectView(role("button", { name: "Add domain" })).toBeDisabled(),
			expectView(
				text("An internal page has no public address. Make it public or password-protected first."),
			).toExist(),
			expectView(role("region", { name: "Break-glass token" })).not.toExist(),
			expectView(role("button", { name: "Issue token" })).not.toExist(),
		)
	})

	test("members see the domain and its records but no control to change them", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings", grants: MEMBER, customDomain: pendingDomain })),
			expectView(text("_cf-custom-hostname.status.acme.com")).toExist(),
			expectView(role("textbox", { name: "Hostname" })).toBeDisabled(),
			expectView(role("button", { name: "Check now" })).not.toExist(),
			expectView(role("button", { name: "Remove" })).not.toExist(),
		)
	})

	test("a deployment without custom domains says so instead of the form", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				loaded({
					tab: "settings",
					customDomain: customDomain({ available: false, cname_target: null }),
				}),
			),
			expectView(text("Custom domains are unavailable on this Maple deployment.")).toExist(),
			expectView(role("textbox", { name: "Hostname" })).not.toExist(),
		)
	})
})

describe("json view", () => {
	const publicComponentId = (n: number) => Schema.encodeSync(StatusPageComponentPublicId)(componentId(n))
	/** The document the tab shows, as the user would edit it. */
	const documentOf = (components: ReadonlyArray<number>) => ({
		name: "Acme Status",
		slug: "acme-status",
		components: Arr.map(components, (n) => ({ id: publicComponentId(n), name: `Component ${n}` })),
	})
	const editing = (draft: string, fixture: Fixture = {}) =>
		Arr.reduce(
			[Message.ClickedEditJson(), Message.ChangedJson({ value: draft })],
			loaded({ tab: "json", ...fixture }),
			(model, message) => pageUpdate(model, message).model,
		)

	test("shows the page as its config document, with public ids", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "json" })),
			expectView(role("link", { name: "Page" })).toHaveAttr("href", `/status-pages/${PUBLIC_ID}`),
			expectView(role("link", { name: "JSON" })).toHaveAttr("aria-current", "page"),
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
			given(loaded({ tab: "json", grants: MEMBER })),
			expectView(selector("pre")).toContainText('"name": "Acme Status"'),
			expectView(role("button", { name: "Edit JSON" })).not.toExist(),
			expectView(role("textbox", { name: "Config JSON" })).not.toExist(),
		)
		const tried = pageUpdate(loaded({ tab: "json", grants: MEMBER }), Message.ClickedEditJson())
		expect(tried.model.jsonEdit).toBeNull()
	})

	test("Edit fills the editor with the current document, and Reset brings it back", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "json" })),
			click(role("button", { name: "Edit JSON" })),
			expectView(role("textbox", { name: "Config JSON" })).toExist(),
			expectView(text("No changes yet")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
			type(role("textbox", { name: "Config JSON" }), "{}"),
			expectView(text("Not a valid page config")).toExist(),
			click(role("button", { name: "Reset" })),
			expectView(text("No changes yet")).toExist(),
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
		expect(applied.model.jsonEdit).toBeNull()
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
		expect(refused.jsonEdit?.draft).toBe(model.jsonEdit?.draft)
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
			expectView(text("No changes yet")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
		const dropped = JSON.stringify({ ...documentOf([1, 2, 3]) })
		const editingConfig = Arr.reduce(
			[Message.ClickedEditJson(), Message.ChangedJson({ value: dropped })],
			model,
			(current, message) => pageUpdate(current, message).model,
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
			components: Arr.map(documentOf([1, 2, 3]).components, (c) => ({
				...c,
				name: ` ${c.name}`,
				group: " ",
			})),
		})
		scene(
			{ update: pageUpdate, view },
			given(editing(draft, { page })),
			expectView(text("No changes yet")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
	})

	test("while an apply runs, typing is ignored, the editor is disabled, and Settings cannot save", () => {
		const draft = JSON.stringify(documentOf([1]))
		const applying = pageUpdate(editing(draft), Message.ClickedApplyJson()).model
		expect(applying.isApplyingJson).toBe(true)
		expect(pageUpdate(applying, Message.ChangedJson({ value: "{}" })).model.jsonEdit?.draft).toBe(draft)
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
		expect(refused.model.jsonEdit?.draft).toBe(applying.jsonEdit?.draft)
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
		expect(reread.jsonEdit?.draft).toBe(draftText)
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
		const reopened = Arr.reduce(
			[
				Message.ClickedCancelJson(),
				Message.ClickedEditJson(),
				Message.ChangedJson({ value: JSON.stringify(documentOf([1])) }),
			],
			refused,
			(model, message) => pageUpdate(model, message).model,
		)
		const reread = pageUpdate(
			reopened,
			Message.CompletedFetchConfig({
				key: reopened.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v7" } },
		])
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
		const reread = pageUpdate(
			stale,
			Message.CompletedFetchConfig({
				key: refused.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v8" } },
		])
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
		const retried = pageUpdate(failed, Message.ClickedRetry()).model
		const reread = pageUpdate(
			retried,
			Message.CompletedFetchConfig({
				key: retried.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v8" } },
		])
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
