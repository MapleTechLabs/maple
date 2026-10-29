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
	click,
	expect as expectView,
	find,
	given,
	inside,
	Mount,
	role,
	scene,
	selector,
	tap,
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
import { component, componentId, incident, incidentId, statusPage, statusPageConfig } from "../test-pages"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
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
	/** The config read's document; by default the page and its components. */
	config?: StatusPageConfig
	configFail?: boolean
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

	test("fresh page and incident reads re-read the clock, so relative times never run ahead", () => {
		const entered = init({ _tag: "AlertsStatusPage", pageId: PUBLIC_ID, search: {} }, context).model
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
			type(role("textbox", { name: "Accent" }), "teal"),
			expectView(text("Unsaved changes")).toExist(),
			expectView(text("Use a hex color like #1a2b3c.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("saving sends every field and settles once the page matches", () => {
		const edited = [
			Message.ChangedThemeColor({ field: "accent", value: "#1A2B3C" }),
			Message.PickedThemePreset({ preset: "paper" }),
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
						theme: { ...DEFAULT_STATUS_PAGE_THEME, preset: "paper", accent: "#1a2b3c" },
						show_powered_by: false,
						auto_incidents: "publish",
						website_url: null,
					},
				},
			},
		])
		const saved = statusPage({
			theme: { ...DEFAULT_STATUS_PAGE_THEME, preset: "paper", accent: "#1a2b3c" },
			show_powered_by: false,
			auto_incidents: "publish",
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
			expectView(selector("iframe")).toHaveAttr("sandbox", ""),
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
				url: statusPagesTabHref(),
				isReplace: true,
				toast: { type: "success", title: "Status page deleted", description: "" },
			}),
		)
	})
})

describe("json tab", () => {
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
		const entered = init(
			{ _tag: "AlertsStatusPage", pageId: PUBLIC_ID, search: { tab: "json" } },
			context,
		)
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
			{ _tag: "AlertsStatusPage", pageId: PUBLIC_ID, search: { tab: "json" } },
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
			{ _tag: "AlertsStatusPage", pageId: PUBLIC_ID, search: { tab: "json" } },
			context,
		)
		expect(names(opened.commands)).toEqual(["FetchStatusPageConfig"])
	})

	test("Apply sends the revision the document was read at", () => {
		const model = editing(JSON.stringify({ ...documentOf([1, 2]) }), {
			config: {
				...statusPageConfig(statusPage(), [component(1), component(2), component(3)]),
				revision: 7,
			},
		})
		expect(pageUpdate(model, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifRevision: 7 } },
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
					result: Result.succeed({ ...documentOf([1]), components: [], revision: 4 }),
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
		const reason = "The page changed since revision 3 (it is now at 4)."
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
