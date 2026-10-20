import { OrgId } from "@maple/domain"
import { V2DashboardTemplate } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { CreateFromTemplate, FetchMetrics, FetchTemplates, WaitPreviewDelay } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, selectedOf, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)

const calls = (commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined) =>
	(commands ?? []).map(({ name, args }) => ({ name, args }))
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const template = (id: string, name: string) =>
	Schema.decodeUnknownSync(Schema.toType(V2DashboardTemplate))({
		id,
		object: "dashboard_template",
		name,
		description: `${name} board.`,
		category: "application",
		tags: [],
		requirements: [],
		requirement: null,
		requiredMetricPrefixes: [],
		parameters: [],
		preview: [],
	})

const TEMPLATES = [template("service-health", "Service Health"), template("blank", "Blank dashboard")]

const loaded = (search: { template?: string } = {}): Return => {
	const entered = init({ search }, context).model
	return pageUpdate(
		entered,
		Message.CompletedFetchTemplates({
			key: entered.templates.key ?? "",
			result: Result.succeed(TEMPLATES),
		}),
	)
}
type Return = ReturnType<typeof update>

describe("dashboard templates", () => {
	test("entry fetches the templates and the metrics readiness reads", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual(
			expect.arrayContaining([FetchTemplates.name, FetchMetrics.name]),
		)
	})

	test("a selection in the URL arms the preview delay once the list resolves it", () => {
		const { model, commands } = loaded({ template: TEMPLATES[0]?.id })
		expect(selectedOf(model)?.name).toBe("Service Health")
		expect(calls(commands)).toEqual([
			{ name: WaitPreviewDelay.name, args: { generation: model.previewGeneration } },
		])
	})

	test("picking another template drops the previous parameters", () => {
		const first = loaded({ template: TEMPLATES[0]?.id }).model
		const edited = pageUpdate(first, Message.ChangedParameter({ key: "service", value: "api" })).model
		const next = routeChanged(edited, { search: { template: TEMPLATES[1]?.id } }).model
		expect(next.parameters).toEqual({})
		expect(selectedOf(next)?.name).toBe("Blank dashboard")
	})

	test("create sends only filled, trimmed parameters and ignores a second click", () => {
		const model = loaded({ template: TEMPLATES[0]?.id }).model
		const filled = [
			Message.ChangedParameter({ key: "service", value: "  checkout " }),
			Message.ChangedParameter({ key: "env", value: "   " }),
		].reduce((current, message) => pageUpdate(current, message).model, model)
		const created = pageUpdate(filled, Message.ClickedCreate({ templateId: "service-health" }))
		expect(calls(created.commands)).toEqual([
			{
				name: CreateFromTemplate.name,
				args: { templateId: "service-health", parameters: { service: "checkout" } },
			},
		])
		expect(
			pageUpdate(created.model, Message.ClickedCreate({ templateId: "service-health" })).commands,
		).toBeUndefined()
	})

	test("a created dashboard opens with a success toast", () => {
		const model = { ...loaded().model, isCreating: true }
		const next = pageUpdate(
			model,
			Message.CompletedCreate({
				result: Result.succeed({ id: "dash_new", name: "Service Health", txid: "1" }),
			}),
		)
		expect(next.model.isCreating).toBe(false)
		expect(next.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_new",
				isReplace: false,
				toast: { type: "success", title: 'Dashboard "Service Health" created', description: "" },
			}),
		)
	})
})
