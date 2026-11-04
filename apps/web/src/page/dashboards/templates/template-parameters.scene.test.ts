import { OrgId } from "@maple/domain"
import { V2DashboardTemplate } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { FetchPreview } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

// The parameter form: the preview asks once typing settles, and only with every required value.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

const template = Schema.decodeUnknownSync(Schema.toType(V2DashboardTemplate))({
	id: "gcp",
	object: "dashboard_template",
	name: "Google Cloud",
	description: "GCP board.",
	category: "infrastructure",
	tags: [],
	requirements: [],
	requirement: null,
	requiredMetricPrefixes: [],
	parameters: [{ key: "project", label: "Project", description: "", required: true }],
	preview: [],
})

type Step = Readonly<{
	model: Model
	commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }>
}>

const step = (model: Model, message: Message): Step => {
	const next = update(model, message, context)
	return { model: next.model, commands: next.commands ?? [] }
}

const previewsOf = (commands: Step["commands"]) =>
	Arr.filter(commands, ({ name }) => name === FetchPreview.name)

const armed = (): Model => {
	const entered = init({ search: { template: "gcp" } }, context).model
	const listed = step(
		entered,
		Message.CompletedFetchTemplates({
			key: entered.templates.key ?? "",
			result: Result.succeed([template]),
		}),
	).model
	return step(listed, Message.ElapsedPreviewDelay({ generation: listed.previewGeneration })).model
}

const typed = (model: Model, value: string): Step =>
	step(model, Message.ChangedParameter({ key: "project", value }))

const settled = (model: Model): Step =>
	step(model, Message.ElapsedParameterDebounce({ generation: model.previewGeneration }))

describe("template parameters", () => {
	test("no preview is asked while a required parameter is empty", () => {
		expect(armed().preview.key).toBeNull()
	})

	test("typing waits for the debounce, and only the last keystroke asks, with trimmed values", () => {
		const first = typed(armed(), "acm")
		expect(previewsOf(first.commands)).toEqual([])
		const second = typed(first.model, "acme ")
		expect(
			previewsOf(
				step(
					second.model,
					Message.ElapsedParameterDebounce({ generation: first.model.previewGeneration }),
				).commands,
			),
		).toEqual([])
		const asked = settled(second.model)
		expect(Arr.map(previewsOf(asked.commands), ({ args }) => args)).toEqual([
			expect.objectContaining({ parameters: { project: "acme" } }),
		])
		const spaced = typed(asked.model, "  acme")
		expect(previewsOf(settled(spaced.model).commands)).toEqual([])
	})
})
