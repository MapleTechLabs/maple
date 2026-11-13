import { OrgId } from "@maple/domain"
import { V2DashboardTemplate } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import type { PageContext } from "../../contract"
import { CreateFromTemplate } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// An analyst previews templates; creating a dashboard from one needs `dashboards:edit`.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const template = Schema.decodeUnknownSync(Schema.toType(V2DashboardTemplate))({
	id: "service-health",
	object: "dashboard_template",
	name: "Service Health",
	description: "Service Health board.",
	category: "application",
	tags: [],
	requirements: [],
	requirement: null,
	requiredMetricPrefixes: [],
	parameters: [],
	preview: [],
})

const MEMBER = Policy.grantsOf(["org:member"])
const ANALYST = Policy.grantsOf(["org:analyst"])

/** The gallery with its one template selected and the session's grants answered. */
const selected = (grants: ReadonlyArray<Policy.Permission>): Model => {
	const entered = init({ search: { template: "service-health" } }, context).model
	return Arr.reduce(
		[
			Message.CompletedFetchSession({ orgId, grants }),
			Message.CompletedFetchTemplates({
				key: entered.templates.key ?? "",
				result: Result.succeed([template]),
			}),
		],
		entered,
		(model, message) => pageUpdate(model, message).model,
	)
}

describe("dashboard templates for an analyst", () => {
	test("the template previews with no way to create from it", () => {
		const model = selected(ANALYST)
		expect(names(pageUpdate(model, Message.ClickedCreate({ templateId: template.id })).commands)).toEqual(
			[],
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
			expectView(text("Service Health board.")).toExist(),
			expectView(role("button", { name: "Create dashboard" })).toBeAbsent(),
			expectView(text("Blank dashboard")).toBeAbsent(),
		)
	})

	test("a member creates from the template or starts blank", () => {
		const model = selected(MEMBER)
		expect(names(pageUpdate(model, Message.ClickedCreate({ templateId: template.id })).commands)).toEqual(
			[CreateFromTemplate.name],
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
			expectView(role("button", { name: "Create dashboard" })).toExist(),
			expectView(text("Blank dashboard")).toExist(),
		)
	})
})
