import { OrgId } from "@maple/domain"
import { StatusPageSlugTakenError } from "@maple/domain/http"
import { StatusPagePreviewParams, type V2UptimeMonitor } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
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
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { ORG } from "../../alerts/shared/test-rows"
import {
	downMonitor,
	heartbeatMonitor,
	httpMonitor,
	monitorId,
} from "../../alerts/shared/uptime-test-monitors"
import { statusPageHref } from "../shared/commands"
import { monitorKey, PickerMessage } from "../shared/picker"
import { statusPage } from "../shared/test-pages"
import { FocusNewRow } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, previewDraft as BuilderUpdatePreviewDraft, update } from "./update"
import { view as builderView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const builderUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(builderView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const picker = (message: PickerMessage) => Message.GotPickerMessage({ message })

const tcpMonitor = () =>
	httpMonitor({
		id: monitorId(6),
		name: "postgres",
		kind: "tcp",
		config: { type: "tcp", host: "db.acme.dev", port: 5432, timeout_ms: 10000 },
	})

const withMonitors = (monitors: ReadonlyArray<V2UptimeMonitor>, isAdmin = true): Model => {
	const start = init({ _tag: "StatusPageNew" }, context).model
	return [
		Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12) }),
		Message.CompletedFetchSession({ orgId: ORG, isAdmin }),
		Message.CompletedFetchMonitors({ key: start.monitors.key ?? "", result: Result.succeed(monitors) }),
	].reduce((model, message) => builderUpdate(model, message).model, start)
}

const named = (model: Model, name = "Acme Status") =>
	builderUpdate(model, Message.ChangedName({ value: name })).model

describe("status page builder", () => {
	test("a small org starts with every monitor on the page except heartbeats", () => {
		const model = withMonitors([httpMonitor(), downMonitor(), tcpMonitor(), heartbeatMonitor()])
		expect(model.picker.rows.map((row) => [row.name, row.isChecked])).toEqual([
			["checkout-api", true],
			["payments-api", true],
			["postgres", true],
			["nightly-billing-export", false],
		])
		scene(
			{ update: builderUpdate, view },
			given(model),
			expectView(text("api.acme.dev/checkout/health")).toExist(),
			expectView(text("db.acme.dev:5432")).toExist(),
			expectView(text("heartbeat")).toExist(),
			expectView(
				role("checkbox", { name: "Show nightly-billing-export on the page" }),
			).not.toBeChecked(),
		)
	})

	test("past eight monitors nothing starts checked", () => {
		const many = Array.from({ length: 9 }, (_, index) =>
			httpMonitor({ id: monitorId(index), name: `m${index}` }),
		)
		expect(withMonitors(many).picker.rows.some((row) => row.isChecked)).toBe(false)
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

	test("a checked row renames inline and moves among the checked rows", () => {
		const model = withMonitors([httpMonitor(), downMonitor(), tcpMonitor()])
		const renamed = builderUpdate(
			model,
			picker(PickerMessage.ChangedRowName({ key: monitorKey(downMonitor().id), value: "Payments" })),
		).model
		const movedUp = builderUpdate(
			renamed,
			picker(PickerMessage.ClickedMoveRow({ key: monitorKey(downMonitor().id), offset: -1 })),
		).model
		expect(movedUp.picker.rows.map((row) => row.name)).toEqual(["Payments", "checkout-api", "postgres"])
		scene(
			{ update: builderUpdate, view },
			given(movedUp),
			expectView(role("button", { name: "Move Payments up" })).toBeDisabled(),
			expectView(role("button", { name: "Move postgres down" })).toBeDisabled(),
			expectView(role("textbox", { name: "Shown as, payments-api" })).toHaveValue("Payments"),
		)
	})

	test("a pasted URL becomes an HTTP monitor, then a checked component", () => {
		const opened = builderUpdate(
			withMonitors([httpMonitor()]),
			picker(PickerMessage.ClickedOpenUrl()),
		).model
		const typed = builderUpdate(opened, picker(PickerMessage.ChangedUrl({ value: "api.acme.com" }))).model
		const creating = builderUpdate(typed, picker(PickerMessage.SubmittedUrl()))
		expect(creating.commands).toMatchObject([
			{ name: "WaitStatusPageBuilderPreview" },
			{ name: "CreateStatusPageMonitor", args: { url: "https://api.acme.com" } },
		])
		const monitor = httpMonitor({ id: monitorId(8), name: "api.acme.com" })
		const created = builderUpdate(
			creating.model,
			Message.CompletedCreateMonitor({ result: Result.succeed(monitor) }),
		).model
		expect(created.picker.rows.at(-1)).toMatchObject({ monitorId: monitor.id, isChecked: true })
		expect(created.picker.url).toBe("")
	})

	test("a URL the uptime form would refuse is refused here, without a create", () => {
		const opened = builderUpdate(
			withMonitors([httpMonitor()]),
			picker(PickerMessage.ClickedOpenUrl()),
		).model
		const typed = builderUpdate(
			opened,
			picker(PickerMessage.ChangedUrl({ value: "http://localhost:3000" })),
		).model
		const refused = builderUpdate(typed, picker(PickerMessage.SubmittedUrl()))
		expect(names(refused.commands)).not.toContain("CreateStatusPageMonitor")
		expect(refused.model.picker.urlIssue).not.toBeNull()
	})

	test("with no monitors, the URL field and the add-by-hand row are the way in", () => {
		scene(
			{ update: builderUpdate, view },
			given(withMonitors([])),
			expectView(text("Paste a URL to monitor, or add a component you'll update by hand.")).toExist(),
			expectView(role("textbox", { name: "URL to monitor" })).toExist(),
			expectView(role("button", { name: "Add a component without a monitor" })).toExist(),
		)
	})

	test("a component without a monitor gets a name and a manual status, and its name field focus", () => {
		const adding = builderUpdate(withMonitors([]), picker(PickerMessage.ClickedAddManual()))
		const row = adding.model.picker.rows[0]
		expect(adding.model.picker.autofocusKey).toBe(row?.key)
		const filled = [
			picker(PickerMessage.ChangedRowName({ key: row?.key ?? "", value: "Docs" })),
			picker(PickerMessage.PickedRowStatus({ key: row?.key ?? "", value: "degraded" })),
		].reduce((model, message) => builderUpdate(model, message).model, named(adding.model))
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
		const added = builderUpdate(
			named(withMonitors([httpMonitor()])),
			picker(PickerMessage.ClickedAddManual()),
		)
		const generation = added.model.previewGeneration
		const fetching = builderUpdate(added.model, Message.ElapsedPreviewDebounce({ generation }))
		const [command] = fetching.commands ?? []
		expect(command).toMatchObject({ name: "FetchStatusPagePreview" })
		const draft = BuilderUpdatePreviewDraft(added.model)
		expect(draft.components.map((component) => component.monitor_id)).toEqual([httpMonitor().id])
		// The args must encode: a blank name would fail the schema and crash the app.
		expect(Schema.encodeSync(StatusPagePreviewParams)(draft).components).toHaveLength(1)
		scene(
			{ update: builderUpdate, view },
			given(added.model),
			Mount.resolve(FocusNewRow, Message.CompletedFocus()),
			expectView(text("Name this component")).toExist(),
			expectView(role("button", { name: "Publish page" })).toBeDisabled(),
		)
	})

	test("keys pressed before the new row's input takes focus land in that row, not nowhere", () => {
		const added = builderUpdate(withMonitors([]), picker(PickerMessage.ClickedAddManual())).model
		const key = added.picker.autofocusKey ?? ""
		const typed = [
			picker(PickerMessage.PressedKeyOnAdd({ key: "W" })),
			picker(PickerMessage.PressedKeyOnAdd({ key: "Enter" })),
			picker(PickerMessage.ChangedRowName({ key, value: "Website" })),
			picker(PickerMessage.PressedKeyOnAdd({ key: "x" })),
		].reduce((model, message) => builderUpdate(model, message).model, added)
		expect(typed.picker.rows.map((row) => row.name)).toEqual(["Website"])
		const routed = builderUpdate(added, picker(PickerMessage.PressedKeyOnAdd({ key: "W" }))).model
		expect(routed.picker.rows[0]?.name).toBe("W")
	})

	test("a plan or URL error clears once a component is added another way", () => {
		const opened = builderUpdate(
			withMonitors([httpMonitor()]),
			picker(PickerMessage.ClickedOpenUrl()),
		).model
		const failed = builderUpdate(
			opened,
			Message.CompletedCreateMonitor({
				result: Result.fail(
					toLoadFailure(new Error("This organization's plan doesn't include uptime monitors.")),
				),
			}),
		).model
		expect(failed.picker.urlIssue).not.toBeNull()
		expect(
			builderUpdate(failed, picker(PickerMessage.ClickedAddManual())).model.picker.urlIssue,
		).toBeNull()
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
			expectView(text("Only org admins can create status pages")).toExist(),
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
			expectView(selector("iframe")).toHaveAttr("sandbox", "allow-scripts"),
			tap(({ html }) => {
				const srcdoc = Option.getOrElse(
					Option.flatMap(find("iframe")(html), attr("srcdoc")),
					() => "",
				)
				expect(srcdoc).toContain("Acme Cloud")
				expect(srcdoc).toContain("color-scheme:dark;")
			}),
		)
	})
})
