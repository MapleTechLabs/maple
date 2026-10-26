import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, role, scene, text, type, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { ORG } from "../shared/test-rows"
import { LIMIT_REACHED_CODE, monitorHref } from "../shared/uptime-commands"
import { httpMonitor } from "../shared/uptime-test-monitors"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { LIMIT_MESSAGE, view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const fresh = (search: Model["search"] = {}): Model =>
	init({ _tag: "AlertsUptimeNew", search }, context).model

const withUrl = (url: string): Model =>
	pageUpdate(fresh(), Message.ChangedText({ field: "url", value: url })).model

describe("uptime monitor form", () => {
	test("a new HTTP check without a URL lists what is missing and cannot be created", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh()),
			expectView(text("Add the URL to check.")).toExist(),
			expectView(role("button", { name: "Create monitor" })).toBeDisabled(),
		)
	})

	test("the name follows the URL until it is typed", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh()),
			type(role("textbox", { name: "URL" }), "https://api.acme.dev/checkout/health"),
			expectView(role("textbox", { name: "Name" })).toHaveValue("api.acme.dev/checkout/health"),
			expectView(text("Ready to save")).toExist(),
		)
	})

	test("a TCP check with a port out of range says which values work", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh()),
			click(role("radio", { name: /TCP port/u })),
			type(role("textbox", { name: "Host" }), "db.acme.dev"),
			type(role("textbox", { name: "Port" }), "99999"),
			expectView(text("The port must be a whole number from 1 to 65535.")).toExist(),
		)
	})

	test("switching to Heartbeat swaps the request for a schedule and explains the ping URL", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh()),
			click(role("radio", { name: /Heartbeat/u })),
			expectView(text("The ping URL appears after you create the monitor.")).toExist(),
			expectView(role("textbox", { name: "Grace period" })).toExist(),
			expectView(role("textbox", { name: "URL" })).not.toExist(),
		)
	})

	test("Run test sends the draft and shows the status, each passing check and the body", () => {
		const testing = pageUpdate(withUrl("https://api.acme.dev/health"), Message.ClickedTest())
		expect(names(testing.commands)).toEqual(["TestUptimeDraft"])
		const done = pageUpdate(
			testing.model,
			Message.CompletedTest({
				result: Result.succeed({
					object: "uptime_monitor.test_result",
					ok: true,
					status_code: 200,
					duration_ms: 96,
					failed_assertion: null,
					error: null,
					headers: {},
					body_prefix: '{"status":"ok"}',
					body_truncated: false,
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(done),
			expectView(text("200")).toExist(),
			expectView(text("Status code is 2xx")).toExist(),
			expectView(text("Response time under 2000 ms")).toExist(),
			expectView(text('{"status":"ok"}')).toExist(),
		)
	})

	test("a failed test names the first failing check", () => {
		const done = pageUpdate(
			pageUpdate(withUrl("https://api.acme.dev/health"), Message.ClickedTest()).model,
			Message.CompletedTest({
				result: Result.succeed({
					object: "uptime_monitor.test_result",
					ok: false,
					status_code: 503,
					duration_ms: 1500,
					failed_assertion: "Status code 503 is not 2xx",
					error: null,
					headers: {},
					body_prefix: null,
					body_truncated: false,
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(done),
			expectView(text("Status code 503 is not 2xx")).toExist(),
		)
	})

	test("a create past the plan's allowance explains the limit instead of a generic error", () => {
		const saving = pageUpdate(withUrl("https://api.acme.dev/health"), Message.ClickedSave())
		expect(names(saving.commands)).toEqual(["SaveUptimeDraft"])
		const limited = pageUpdate(
			saving.model,
			Message.CompletedSave({
				result: Result.fail({ ...toLoadFailure(new Error("limit")), code: LIMIT_REACHED_CODE }),
			}),
		)
		expect(limited.outMessage).toBeUndefined()
		scene({ update: pageUpdate, view }, given(limited.model), expectView(text(LIMIT_MESSAGE)).toExist())
	})

	test("a saved monitor opens its page with a toast", () => {
		const saving = pageUpdate(withUrl("https://api.acme.dev/health"), Message.ClickedSave())
		const monitor = httpMonitor()
		const saved = pageUpdate(saving.model, Message.CompletedSave({ result: Result.succeed(monitor) }))
		expect(saved.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: monitorHref(monitor.id),
				isReplace: true,
				toast: { type: "success", title: "Monitor created", description: "" },
			}),
		)
	})

	test("the service from the URL is preselected", () => {
		expect(fresh({ serviceName: "checkout-api" }).form.serviceName).toBe("checkout-api")
	})
})
