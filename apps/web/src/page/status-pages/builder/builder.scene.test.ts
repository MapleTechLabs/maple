import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { StatusPageSlugTakenError } from "@maple/domain/http"
import { StatusPagePreviewParams, type V2UptimeMonitor } from "@maple/domain/http/v2"
import { Option, Result, Schema, Array as Arr } from "effect"
import {
	attr,
	expect as expectView,
	find,
	given,
	Mount,
	role,
	scene,
	selector,
	tap,
	text,
	withViewInputs,
	within,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { ORG } from "../../kit/alert-test-rows"
import { downMonitor, heartbeatMonitor, httpMonitor, monitorId } from "../../kit/uptime/test-monitors"
import { statusPageHref } from "../shared/commands"
import * as Dialog from "@maple/views/ui/dialog"
import { MountDialog } from "@maple/views/ui/dialog"
import * as Combobox from "@maple/views/ui/combobox"
import { groupPickerValue } from "../shared/group-picker"
import { monitorKey, PickerMessage } from "../shared/picker"
import { statusPage } from "../shared/test-pages"
import { Message } from "./message"
import type { Model } from "./model"
import { init, orderedRows, previewDraft as BuilderUpdatePreviewDraft, routeChanged, update } from "./update"
import { view as builderView } from "./view"

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const builderUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(builderView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const addPicker = (message: PickerMessage) => Message.GotAddPickerMessage({ message })
const group = (message: Combobox.Message) => Message.GotGroupPickerMessage({ message })

const tcpMonitor = () =>
	httpMonitor({
		id: monitorId(6),
		name: "postgres",
		kind: "tcp",
		config: { type: "tcp", host: "db.acme.dev", port: 5432, timeout_ms: 10000 },
	})

const withMonitors = (
	monitors: ReadonlyArray<V2UptimeMonitor>,
	canEdit = true,
	setup: "agent" | "manual" | null = "manual",
): Model => {
	const start = init({ _tag: "StatusPageNew", search: setup === null ? {} : { setup } }, context).model
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12) }),
			Message.CompletedFetchSession({ orgId: ORG, grants: canEdit ? ENGINEER : MEMBER }),
			Message.CompletedFetchMonitors({
				key: start.monitors.key ?? "",
				result: Result.succeed(monitors),
			}),
		],
		start,
		(model, message) => builderUpdate(model, message).model,
	)
}

const named = (model: Model, name = "Acme Status") =>
	builderUpdate(model, Message.ChangedName({ value: name })).model

describe("status page builder", () => {
	test("a small org starts with every monitor on the page except heartbeats", () => {
		const model = withMonitors([httpMonitor(), downMonitor(), tcpMonitor(), heartbeatMonitor()])
		expect(Arr.map(model.rows, (row) => row.form.name)).toEqual([
			"checkout-api",
			"payments-api",
			"postgres",
		])
		scene(
			{ update: builderUpdate, view },
			given(model),
			expectView(role("button", { name: /^checkout-api/u })).toHaveAttr("aria-expanded", "false"),
			expectView(text("Monitor: postgres")).toExist(),
			expectView(text("nightly-billing-export")).not.toExist(),
		)
	})

	test("past eight monitors the page starts empty, and the monitors are added from the sheet", () => {
		const many = Array.from({ length: 9 }, (_, index) =>
			httpMonitor({ id: monitorId(index), name: `m${index}` }),
		)
		const model = withMonitors(many)
		expect(model.rows).toEqual([])
		scene(
			{ update: builderUpdate, view },
			given(model),
			expectView(
				text(
					"Nothing yet. Add your monitors, a URL for Maple to check, or a component you update yourself.",
				),
			).toExist(),
		)
		const opened = builderUpdate(model, Message.ClickedAddComponents()).model
		expect(opened.addSheet.isOpen).toBe(true)
		expect(Arr.some(opened.addPicker.rows, (row) => row.isChecked)).toBe(false)
		const added = Arr.reduce(
			[
				addPicker(PickerMessage.ToggledRow({ key: monitorKey(monitorId(2)) })),
				Message.ClickedSubmitAdd(),
			],
			opened,
			(current, message) => builderUpdate(current, message).model,
		)
		expect(Arr.map(added.rows, (row) => row.form.name)).toEqual(["m2"])
		expect(added.addSheet.isOpen).toBe(false)
	})

	test("the sheet offers only the monitors not on the page yet", () => {
		const opened = builderUpdate(
			withMonitors([httpMonitor(), downMonitor(), heartbeatMonitor()]),
			Message.ClickedAddComponents(),
		).model
		expect(Arr.map(opened.addPicker.rows, (row) => row.name)).toEqual(["nightly-billing-export"])
	})

	test("the address follows the name until it is typed", () => {
		const step = (model: Model, message: Message) => builderUpdate(model, message).model
		const followed = step(
			withMonitors([httpMonitor()]),
			Message.ChangedName({ value: "Acme Cloud Status" }),
		)
		expect(followed.slug).toBe("acme-cloud-status")
		const typed = step(
			step(followed, Message.ChangedSlug({ value: "status" })),
			Message.ChangedName({ value: "Acme" }),
		)
		scene(
			{ update: builderUpdate, view },
			given(typed),
			expectView(role("textbox", { name: "Name" })).toHaveValue("Acme"),
			expectView(role("textbox", { name: "Address" })).toHaveValue("status"),
		)
	})

	test("a row opens in place with its fields, renames, and moves within its group", () => {
		const model = withMonitors([httpMonitor(), downMonitor(), tcpMonitor()])
		const key = monitorKey(downMonitor().id)
		const opened = builderUpdate(model, Message.ClickedRow({ key })).model
		const renamed = builderUpdate(
			opened,
			Message.ChangedRowField({ field: "name", value: "Payments" }),
		).model
		const movedUp = builderUpdate(renamed, Message.PressedMoveRow({ key, offset: -1 }))
		expect(names(movedUp.commands)).toContain("FocusStatusPageBuilderField")
		expect(Arr.map(movedUp.model.rows, (row) => row.form.name)).toEqual([
			"Payments",
			"checkout-api",
			"postgres",
		])
		scene(
			{ update: builderUpdate, view },
			given(movedUp.model),
			expectView(role("button", { name: /^Payments/u })).toHaveAttr("aria-expanded", "true"),
			expectView(role("textbox", { name: "Shown as" })).toHaveValue("Payments"),
			expectView(role("button", { name: "Reorder Payments" })).toExist(),
		)
		const dropped = builderUpdate(
			movedUp.model,
			Message.DroppedRow({ key: monitorKey(tcpMonitor().id), index: 0 }),
		).model
		expect(Arr.map(dropped.rows, (row) => row.form.name)).toEqual([
			"postgres",
			"Payments",
			"checkout-api",
		])
	})

	test("Group is created from the dropdown or picked from the page's groups, and the page lists each group together", () => {
		const model = named(withMonitors([httpMonitor(), downMonitor(), tcpMonitor()]))
		const grouped = Arr.reduce(
			[
				Message.ClickedRow({ key: monitorKey(httpMonitor().id) }),
				group(Combobox.Message.ClickedTriggerOf({ items: [] })),
				group(Combobox.Message.ChangedInput({ value: " Core " })),
				group(Combobox.Message.ClickedItem({ value: groupPickerValue.create("Core") })),
				Message.ClickedRow({ key: monitorKey(tcpMonitor().id) }),
				group(Combobox.Message.ClickedTriggerOf({ items: [] })),
			],
			model,
			(current, message) => builderUpdate(current, message).model,
		)
		scene(
			{ update: builderUpdate, view },
			given(grouped),
			Mount.resolve(Combobox.MountCombobox, Combobox.Message.CompletedMountCombobox()),
			expectView(role("option", { name: "Core" })).toExist(),
			expectView(role("option", { name: "No group" })).toExist(),
		)
		const picked = builderUpdate(
			grouped,
			group(Combobox.Message.ClickedItem({ value: groupPickerValue.group("Core") })),
		).model
		expect(picked.groupPicker.isOpen).toBe(false)
		expect(builderUpdate(picked, Message.ClickedSubmit({ mode: "publish" })).commands).toMatchObject([
			{
				name: "CreateStatusPage",
				args: {
					payload: {
						components: [
							{ name: "checkout-api", group: "Core" },
							{ name: "postgres", group: "Core" },
							{ name: "payments-api", group: null },
						],
					},
				},
			},
		])
	})

	test("a group moves with its rows among the groups, and the page lists them in that order", () => {
		const grouped = Arr.reduce(
			[
				Message.ClickedRow({ key: monitorKey(downMonitor().id) }),
				group(Combobox.Message.ClickedItem({ value: groupPickerValue.create("Payments") })),
				Message.DroppedGroup({ group: "Payments", index: 0 }),
			],
			named(withMonitors([httpMonitor(), downMonitor(), tcpMonitor()])),
			(current, message) => builderUpdate(current, message).model,
		)
		expect(Arr.map(orderedRows(grouped), (row) => row.form.name)).toEqual([
			"payments-api",
			"checkout-api",
			"postgres",
		])
		const nudged = builderUpdate(grouped, Message.PressedMoveGroup({ group: "Payments", offset: 1 }))
		expect(names(nudged.commands)).toContain("FocusStatusPageBuilderField")
		expect(Arr.map(orderedRows(nudged.model), (row) => row.form.name)).toEqual([
			"checkout-api",
			"postgres",
			"payments-api",
		])
	})

	test("Remove from page takes the row off", () => {
		const model = withMonitors([httpMonitor(), downMonitor()])
		const removed = builderUpdate(
			model,
			Message.ClickedRemoveRow({ key: monitorKey(httpMonitor().id) }),
		).model
		expect(Arr.map(removed.rows, (row) => row.form.name)).toEqual(["payments-api"])
	})

	test("a pasted URL becomes an HTTP monitor, then a component on the page", () => {
		const opened = Arr.reduce(
			[Message.ClickedAddComponents(), addPicker(PickerMessage.ClickedOpenUrl())],
			withMonitors([httpMonitor()]),
			(current, message) => builderUpdate(current, message).model,
		)
		const typed = builderUpdate(
			opened,
			addPicker(PickerMessage.ChangedUrl({ value: "api.acme.com" })),
		).model
		const creating = builderUpdate(typed, addPicker(PickerMessage.SubmittedUrl()))
		expect(creating.commands).toMatchObject([
			{ name: "CreateStatusPageMonitor", args: { url: "https://api.acme.com" } },
		])
		const monitor = httpMonitor({ id: monitorId(8), name: "api.acme.com" })
		const answered = builderUpdate(
			creating.model,
			Message.CompletedCreateMonitor({ result: Result.succeed(monitor) }),
		)
		expect(answered.model.rows.at(-1)?.form).toMatchObject({
			name: "api.acme.com",
			monitorId: monitor.id,
		})
		expect(answered.model.addSheet.isOpen).toBe(false)
		expect(answered.commands).toContainEqual(
			expect.objectContaining({ name: "TrackStatusPageMonitorCreated", args: { kind: "http" } }),
		)
	})

	test("a URL the uptime form would refuse is refused here, without a create", () => {
		const typed = Arr.reduce(
			[
				Message.ClickedAddComponents(),
				addPicker(PickerMessage.ClickedOpenUrl()),
				addPicker(PickerMessage.ChangedUrl({ value: "http://localhost:3000" })),
			],
			withMonitors([httpMonitor()]),
			(current, message) => builderUpdate(current, message).model,
		)
		const refused = builderUpdate(typed, addPicker(PickerMessage.SubmittedUrl()))
		expect(names(refused.commands)).not.toContain("CreateStatusPageMonitor")
		expect(refused.model.addPicker.urlIssue).not.toBeNull()
	})

	test("with no monitors, the sheet opens on the URL field and says what each way of adding does", () => {
		const model = withMonitors([])
		scene(
			{ update: builderUpdate, view },
			given(model),
			expectView(
				text("Nothing yet. Add a URL for Maple to check, or a component you update yourself."),
			).toExist(),
		)
		scene(
			{ update: builderUpdate, view },
			given(builderUpdate(model, Message.ClickedAddComponents()).model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("textbox", { name: "URL to monitor" })).toExist(),
			expectView(role("button", { name: "Add a component without a monitor" })).toExist(),
			expectView(text(/^For what Maple can't check/u)).toExist(),
		)
	})

	test("a component without a monitor gets a name and a manual status, and its name field focus", () => {
		const adding = Arr.reduce(
			[Message.ClickedAddComponents(), addPicker(PickerMessage.ClickedAddManual())],
			named(withMonitors([])),
			(current, message) => builderUpdate(current, message).model,
		)
		const key = adding.addPicker.autofocusKey ?? ""
		expect(key).not.toBe("")
		const filled = Arr.reduce(
			[
				addPicker(PickerMessage.ChangedRowName({ key, value: "Docs" })),
				addPicker(PickerMessage.PickedRowStatus({ key, value: "degraded" })),
				Message.ClickedSubmitAdd(),
			],
			adding,
			(current, message) => builderUpdate(current, message).model,
		)
		expect(builderUpdate(filled, Message.ClickedSubmit({ mode: "publish" })).commands).toMatchObject([
			{
				name: "CreateStatusPage",
				args: {
					payload: {
						components: [
							{ name: "Docs", monitor_id: null, manual_status: "degraded", show_uptime: true },
						],
					},
				},
			},
		])
	})

	test("an unnamed component never reaches a request: the preview leaves it out and Publish waits", () => {
		const cleared = Arr.reduce(
			[
				Message.ClickedRow({ key: monitorKey(downMonitor().id) }),
				Message.ChangedRowField({ field: "name", value: " " }),
			],
			named(withMonitors([httpMonitor(), downMonitor()])),
			(current, message) => builderUpdate(current, message).model,
		)
		const draft = BuilderUpdatePreviewDraft(cleared)
		expect(Arr.map(draft.components, (component) => component.monitor_id)).toEqual([httpMonitor().id])
		// The args must encode: a blank name would fail the schema and crash the app.
		expect(Schema.encodeSync(StatusPagePreviewParams)(draft).components).toHaveLength(1)
		scene(
			{ update: builderUpdate, view },
			given(cleared),
			expectView(text("Add a name.")).toExist(),
			expectView(role("button", { name: "Publish page" })).toBeDisabled(),
		)
	})

	test("keys pressed before the new row's input takes focus land in that row, not nowhere", () => {
		const added = Arr.reduce(
			[Message.ClickedAddComponents(), addPicker(PickerMessage.ClickedAddManual())],
			withMonitors([]),
			(current, message) => builderUpdate(current, message).model,
		)
		const key = added.addPicker.autofocusKey ?? ""
		const typed = Arr.reduce(
			[
				addPicker(PickerMessage.PressedKeyOnAdd({ key: "W" })),
				addPicker(PickerMessage.PressedKeyOnAdd({ key: "Enter" })),
				addPicker(PickerMessage.ChangedRowName({ key, value: "Website" })),
				addPicker(PickerMessage.PressedKeyOnAdd({ key: "x" })),
			],
			added,
			(model, message) => builderUpdate(model, message).model,
		)
		expect(Arr.map(typed.addPicker.rows, (row) => row.name)).toEqual(["Website"])
	})

	test("a plan or URL error clears once a component is added another way", () => {
		const opened = Arr.reduce(
			[Message.ClickedAddComponents(), addPicker(PickerMessage.ClickedOpenUrl())],
			withMonitors([httpMonitor()]),
			(current, message) => builderUpdate(current, message).model,
		)
		const failed = builderUpdate(
			opened,
			Message.CompletedCreateMonitor({
				result: Result.fail(
					toLoadFailure(new Error("This organization's plan doesn't include uptime monitors.")),
				),
			}),
		).model
		expect(failed.addPicker.urlIssue).not.toBeNull()
		expect(
			builderUpdate(failed, addPicker(PickerMessage.ClickedAddManual())).model.addPicker.urlIssue,
		).toBeNull()
	})

	test("a custom domain is optional, checked as typed, and blocks the create while it is invalid", () => {
		const model = named(withMonitors([httpMonitor()]))
		scene(
			{ update: builderUpdate, view },
			given(model),
			expectView(role("textbox", { name: "Domain" })).toHaveValue(""),
			expectView(text(/^Pick a subdomain you own/u)).toExist(),
			expectView(role("button", { name: "Publish page" })).toBeEnabled(),
		)
		const apex = builderUpdate(model, Message.ChangedCustomDomain({ value: "acme.com" })).model
		scene(
			{ update: builderUpdate, view },
			given(apex),
			expectView(
				text("Use a subdomain, like status.acme.com: an apex domain cannot point at Maple."),
			).toExist(),
			expectView(role("button", { name: "Publish page" })).toBeDisabled(),
		)
	})

	test("with a custom domain, the page is created, the domain set, and the page opens on its DNS records", () => {
		const model = builderUpdate(
			named(withMonitors([httpMonitor()])),
			Message.ChangedCustomDomain({ value: " Status.Acme.com " }),
		).model
		const page = statusPage()
		const created = builderUpdate(
			builderUpdate(model, Message.ClickedSubmit({ mode: "publish" })).model,
			Message.CompletedCreate({ mode: "publish", result: Result.succeed(page) }),
		)
		expect(created.outMessage).toBeUndefined()
		expect(created.model.submitting).toBe("publish")
		expect(created.commands).toMatchObject([
			{ name: "TrackStatusPageCreated" },
			{ name: "SetStatusPageBuilderCustomDomain", args: { hostname: "status.acme.com" } },
		])
		const domain = {
			object: "status_page_custom_domain" as const,
			page_id: page.id,
			available: true,
			cname_target: "status-domains.maple.dev",
			hostname: "status.acme.com",
			status: "pending_dns" as const,
			dns_records: [],
			last_error: null,
			last_checked_at: null,
			activated_at: null,
			created_at: null,
		}
		expect(
			builderUpdate(
				created.model,
				Message.CompletedSetCustomDomain({ page, result: Result.succeed(domain) }),
			).outMessage,
		).toMatchObject({
			_tag: "RequestedNavigation",
			url: statusPageHref(page.id, "settings", "basic"),
			toast: { type: "success" },
		})
		expect(
			builderUpdate(
				created.model,
				Message.CompletedSetCustomDomain({
					page,
					result: Result.fail(toLoadFailure(new Error("Custom domains are unavailable"))),
				}),
			).outMessage,
		).toMatchObject({
			_tag: "RequestedNavigation",
			url: statusPageHref(page.id, "settings", "basic"),
			toast: { type: "error", title: "Acme Status created, but its custom domain wasn't set" },
		})
	})

	test("Cancel sits in the publish bar beside the two ways to save, back to the list", () => {
		scene(
			{ update: builderUpdate, view },
			given(named(withMonitors([httpMonitor()]))),
			expectView(
				within(role("region", { name: "Publish" }), role("link", { name: "Cancel" })),
			).toHaveAttr("href", "/status-pages"),
		)
	})

	test("a taken address shows next to the field and blocks publishing until it changes", () => {
		const model = named(withMonitors([httpMonitor()]))
		const sending = builderUpdate(model, Message.ClickedSubmit({ mode: "publish" })).model
		const refused = builderUpdate(
			sending,
			Message.CompletedCreate({
				mode: "publish",
				result: Result.fail(
					toLoadFailure(new StatusPageSlugTakenError({ slug: "acme-status", message: "taken" })),
				),
			}),
		)
		expect(names(refused.commands)).toContain("FocusStatusPageBuilderField")
		scene(
			{ update: builderUpdate, view },
			given(refused.model),
			expectView(text("That address is taken. Pick another.")).toExist(),
			expectView(role("button", { name: "Publish page" })).toBeDisabled(),
		)
		const changed = builderUpdate(refused.model, Message.ChangedSlug({ value: "acme-status-2" })).model
		scene(
			{ update: builderUpdate, view },
			given(changed),
			expectView(text("That address is taken. Pick another.")).not.toExist(),
			expectView(role("button", { name: "Publish page" })).not.toBeDisabled(),
		)
		expect(
			builderUpdate(refused.model, Message.ClickedSubmit({ mode: "publish" })).commands ?? [],
		).toEqual([])
	})

	test("an address the API would refuse says why and cannot be sent", () => {
		const model = builderUpdate(
			named(withMonitors([httpMonitor()])),
			Message.ChangedSlug({ value: "a" }),
		).model
		scene(
			{ update: builderUpdate, view },
			given(model),
			expectView(text("Use 3 to 48 lowercase letters, digits or inner hyphens.")).toExist(),
			expectView(role("button", { name: "Publish page" })).toBeDisabled(),
			expectView(role("button", { name: "Save as draft" })).toBeDisabled(),
		)
	})

	test("Publish sends one create with the components in order and publish, then opens the live screen", () => {
		const model = named(withMonitors([httpMonitor(), downMonitor(), heartbeatMonitor()]))
		const sending = builderUpdate(model, Message.ClickedSubmit({ mode: "publish" }))
		expect(sending.commands).toMatchObject([
			{
				name: "CreateStatusPage",
				args: {
					mode: "publish",
					payload: {
						name: "Acme Status",
						slug: "acme-status",
						theme: { preset: "default", appearance: "auto" },
						components: [
							{ name: "checkout-api", monitor_id: httpMonitor().id },
							{ name: "payments-api", monitor_id: downMonitor().id },
						],
						publish: true,
					},
				},
			},
		])
		expect(
			builderUpdate(sending.model, Message.ClickedSubmit({ mode: "publish" })).commands ?? [],
		).toEqual([])
		const page = statusPage()
		const done = builderUpdate(
			sending.model,
			Message.CompletedCreate({ mode: "publish", result: Result.succeed(page) }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: statusPageHref(page.id, "live"), isReplace: true }),
		)
	})

	test("Save as draft sends publish false and opens the page, which shows it is a draft", () => {
		const model = named(withMonitors([httpMonitor()]))
		const sending = builderUpdate(model, Message.ClickedSubmit({ mode: "draft" }))
		expect(sending.commands).toMatchObject([
			{ name: "CreateStatusPage", args: { payload: { publish: false } } },
		])
		const page = statusPage({ draft: true, published_at: null })
		const done = builderUpdate(
			sending.model,
			Message.CompletedCreate({ mode: "draft", result: Result.succeed(page) }),
		)
		expect(done.outMessage).toMatchObject({ _tag: "RequestedNavigation", url: statusPageHref(page.id) })
	})

	test("edits ask for a preview once they pause; an older wait or answer is dropped", () => {
		const model = withMonitors([httpMonitor()])
		const first = builderUpdate(model, Message.ChangedName({ value: "A" }))
		const second = builderUpdate(first.model, Message.ChangedName({ value: "Ac" }))
		expect(names(second.commands)).toEqual(["WaitStatusPageBuilderPreview"])
		const generation = second.model.previewGeneration
		expect(
			builderUpdate(second.model, Message.ElapsedPreviewDebounce({ generation: generation - 1 }))
				.commands ?? [],
		).toEqual([])
		const fetching = builderUpdate(second.model, Message.ElapsedPreviewDebounce({ generation }))
		expect(fetching.commands).toMatchObject([
			{
				name: "FetchStatusPagePreview",
				args: { generation, draft: { name: "Ac", components: [{ monitor_id: httpMonitor().id }] } },
			},
		])
		scene({ update: builderUpdate, view }, given(fetching.model), expectView(text("Updating")).toExist())
	})

	test("members are told only admins create pages", () => {
		scene(
			{ update: builderUpdate, view },
			given(withMonitors([httpMonitor()], false)),
			expectView(text("Only org admins and engineers can create status pages")).toExist(),
			expectView(role("button", { name: "Publish page" })).not.toExist(),
		)
	})

	test("the preview is the public renderer in a sandboxed frame, following the draft", () => {
		const model = named(withMonitors([httpMonitor()]), "Acme Cloud")
		const dark = builderUpdate(model, Message.PickedPreviewScheme({ scheme: "dark" }))
		expect(dark.commands ?? []).toEqual([])
		scene(
			{ update: builderUpdate, view },
			given(dark.model),
			expectView(selector("maple-preview-frame")).toHaveAttr("sandbox", "allow-scripts"),
			tap(({ html }) => {
				const srcdoc = Option.getOrElse(
					Option.flatMap(find("maple-preview-frame")(html), attr("srcdoc")),
					() => "",
				)
				expect(srcdoc).toContain("Acme Cloud")
				expect(srcdoc).toContain("color-scheme:dark;")
			}),
		)
	})
})

describe("status page setup method", () => {
	test("a new page starts with the choice between an agent and the dashboard", () => {
		scene(
			{ update: builderUpdate, view },
			given(withMonitors([httpMonitor()], true, null)),
			expectView(role("link", { name: "Get the prompt" })).toHaveAttr(
				"href",
				"/status-pages/new?setup=agent",
			),
			expectView(role("link", { name: "Open the builder" })).toHaveAttr(
				"href",
				"/status-pages/new?setup=manual",
			),
			expectView(role("textbox", { name: "Name" })).not.toExist(),
		)
	})

	test("the agent method shows the MCP setup and a prompt that creates the page through it", () => {
		const model = withMonitors([httpMonitor()], true, "agent")
		scene(
			{ update: builderUpdate, view },
			given(model),
			expectView(role("button", { name: /Build with your agent/u })).toExist(),
			expectView(role("link", { name: "Set it up in the dashboard instead" })).toHaveAttr(
				"href",
				"/status-pages/new?setup=manual",
			),
			expectView(role("textbox", { name: "Name" })).not.toExist(),
		)
	})

	test("switching to the dashboard keeps what was typed in the builder", () => {
		const typed = named(withMonitors([httpMonitor()]), "Acme Status")
		const back = routeChanged(typed, { _tag: "StatusPageNew", search: {} }).model
		expect(back.setup).toBeNull()
		const again = routeChanged(back, { _tag: "StatusPageNew", search: { setup: "manual" } }).model
		scene(
			{ update: builderUpdate, view },
			given(again),
			expectView(role("textbox", { name: "Name" })).toHaveAttr("value", "Acme Status"),
		)
	})

	test("a member gets no choice of method", () => {
		scene(
			{ update: builderUpdate, view },
			given(withMonitors([httpMonitor()], false, null)),
			expectView(text("Only org admins and engineers can create status pages")).toExist(),
			expectView(role("link", { name: "Get the prompt" })).not.toExist(),
		)
	})
})
