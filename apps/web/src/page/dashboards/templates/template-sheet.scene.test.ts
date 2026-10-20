import { OrgId } from "@maple/domain"
import { V2DashboardTemplate } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import * as Dialog from "../../../ui/dialog"
import { PageOutMessage, type PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// Below `lg` the detail panel is a right sheet over the list (`panelIsSheet`).

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

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

const selected = (): Model => {
	const entered = init({ search: { template: "service-health" } }, context).model
	return update(entered, Message.CompletedFetchTemplates({ key: entered.templates.key ?? "", result: Result.succeed([template]) }), context).model
}

describe("templates below lg", () => {
	test("the selected template's panel opens in a sheet", () => {
		scene(
			{ update: (model, message) => update(model, message, context), view: withViewInputs(pageView, { context, isBelowLg: true })() },
			given(selected()),
			Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("dialog", { name: "Service Health" })).toExist(),
			expectView(role("button", { name: "Create dashboard" })).toExist(),
		)
	})

	test("dismissing the sheet clears the selection", () => {
		const dismissed = update(selected(), Message.GotPanelSheetMessage({ message: Dialog.Message.PressedEscape() }), context)
		expect(dismissed.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/dashboards/templates", isReplace: true }),
		)
	})
})
