import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, type, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import { PageOutMessage, type PageContext } from "../../../contract"
import { Message as HubMessage } from "../../hub/message"
import type { Model as HubModel } from "../../hub/model"
import { init, update } from "../../hub/update"
import { view as hubView } from "../../hub/view"
import { statusPageHref } from "../../shared/status-page-commands"
import type { StatusPageSummary } from "../../shared/status-page-derive"
import { NOW, ORG } from "../../shared/test-rows"
import { statusPage } from "../test-pages"
import { Message } from "./message"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const hubUpdate = (model: HubModel, message: HubMessage) => update(model, message, context)
const view = withViewInputs(hubView, { context })()
const tab = (message: Message) => HubMessage.GotStatusPagesMessage({ message })
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const onTab = (isAdmin = true): HubModel => {
	const entered = init({ _tag: "Alerts", search: { tab: "status-pages" } }, context).model
	return [
		HubMessage.ReadClock({ nowMs: NOW }),
		HubMessage.CompletedFetchSession({ orgId: ORG, isAdmin }),
	].reduce((model, message) => hubUpdate(model, message).model, entered)
}

const withPages = (pages: ReadonlyArray<StatusPageSummary>, isAdmin = true): HubModel => {
	const model = onTab(isAdmin)
	return hubUpdate(
		model,
		tab(
			Message.CompletedFetchPages({
				key: model.statusPages.pages.key ?? "",
				result: Result.succeed(pages),
			}),
		),
	).model
}

const opened = (): HubModel => hubUpdate(withPages([]), tab(Message.ClickedNew())).model

describe("alerts hub, status pages tab", () => {
	test("opening the tab reads the pages, and no other tab does", () => {
		const entered = init({ _tag: "Alerts", search: { tab: "status-pages" } }, context)
		expect(names(entered.commands)).toContain("FetchStatusPageSummaries")
		const inbox = init({ _tag: "Alerts", search: {} }, context)
		expect(names(inbox.commands)).not.toContain("FetchStatusPageSummaries")
	})

	test("an org without pages gets the create on-ramp, members are told who can", () => {
		scene(
			{ update: hubUpdate, view },
			given(withPages([])),
			expectView(text("No status pages yet")).toExist(),
			expectView(role("button", { name: "Create a status page" })).toExist(),
		)
		scene(
			{ update: hubUpdate, view },
			given(withPages([], false)),
			expectView(role("button", { name: "Create a status page" })).not.toExist(),
			expectView(text("Ask an org admin to create one.")).toExist(),
		)
	})

	test("a row shows the name, address, status, open incidents and publish state", () => {
		const summary: StatusPageSummary = {
			page: statusPage({ published_at: null }),
			overall: "partial_outage",
			componentCount: 3,
			openIncidents: 2,
		}
		scene(
			{ update: hubUpdate, view },
			given(withPages([summary])),
			expectView(role("link", { name: "Acme Status" })).toHaveAttr(
				"href",
				statusPageHref(summary.page.id),
			),
			expectView(text("/s/acme-status")).toExist(),
			expectView(text("Partial outage")).toExist(),
			expectView(text("2")).toExist(),
			expectView(text("Not published")).toExist(),
		)
	})

	test("a failed read offers a retry that reads again", () => {
		const model = onTab()
		const failed = hubUpdate(
			model,
			tab(
				Message.CompletedFetchPages({
					key: model.statusPages.pages.key ?? "",
					result: Result.fail(toLoadFailure(new Error("down"))),
				}),
			),
		).model
		scene(
			{ update: hubUpdate, view },
			given(failed),
			expectView(text("Couldn't load status pages")).toExist(),
		)
		expect(names(hubUpdate(failed, tab(Message.ClickedRetry())).commands)).toEqual([
			"FetchStatusPageSummaries",
		])
	})

	test("the address follows the name until it is typed", () => {
		scene(
			{ update: hubUpdate, view },
			given(opened()),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			type(role("textbox", { name: "Name" }), "Acme Cloud Status"),
			expectView(role("textbox", { name: "Address" })).toHaveValue("acme-cloud-status"),
			type(role("textbox", { name: "Address" }), "status"),
			type(role("textbox", { name: "Name" }), "Acme"),
			expectView(role("textbox", { name: "Address" })).toHaveValue("status"),
		)
	})

	test("an address the API would refuse says why and cannot be submitted", () => {
		const typed = [Message.ChangedName({ value: "Acme" }), Message.ChangedSlug({ value: "a" })].reduce(
			(model, message) => hubUpdate(model, tab(message)).model,
			opened(),
		)
		scene(
			{ update: hubUpdate, view },
			given(typed),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Use 3 to 48 lowercase letters, digits or inner hyphens.")).toExist(),
			expectView(role("button", { name: "Create status page" })).toBeDisabled(),
		)
		expect(hubUpdate(typed, tab(Message.SubmittedCreate())).commands ?? []).toEqual([])
	})

	test("creating sends the name and address once, then opens the new page", () => {
		const typed = hubUpdate(opened(), tab(Message.ChangedName({ value: "Acme Status" }))).model
		const creating = hubUpdate(typed, tab(Message.SubmittedCreate()))
		expect(creating.commands).toMatchObject([
			{ name: "CreateStatusPage", args: { payload: { name: "Acme Status", slug: "acme-status" } } },
		])
		expect(hubUpdate(creating.model, tab(Message.SubmittedCreate())).commands ?? []).toEqual([])
		const page = statusPage()
		const done = hubUpdate(creating.model, tab(Message.CompletedCreate({ result: Result.succeed(page) })))
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: statusPageHref(page.id),
				isReplace: false,
				toast: { type: "success", title: "Status page created", description: "" },
			}),
		)
	})

	test("a refused create keeps the dialog open with the server's reason", () => {
		const typed = hubUpdate(opened(), tab(Message.ChangedName({ value: "Acme Status" }))).model
		const creating = hubUpdate(typed, tab(Message.SubmittedCreate())).model
		const failed = hubUpdate(
			creating,
			tab(Message.CompletedCreate({ result: Result.fail(toLoadFailure(new Error("slug taken"))) })),
		).model
		expect(failed.statusPages.createDialog.isOpen).toBe(true)
		scene(
			{ update: hubUpdate, view },
			given(failed),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Couldn't create the page")).toExist(),
		)
	})
})
