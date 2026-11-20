import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Schema, Array as Arr } from "effect"
import { Mount, expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import * as Menu from "@maple/views/ui/menu"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, isEditing, routeChanged, update } from "./update"
import { view as pageView } from "./view"

// A custom role reads every board, but edits and shares only with the permission the API checks.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const ROUTE = { dashboardId: "dash_roles", search: {} }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const mounted = () => [Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))]

const READER: ReadonlyArray<Policy.Permission> = ["telemetry:read", "dashboards:share"]
const EDITOR_NO_SHARE: ReadonlyArray<Policy.Permission> = ["telemetry:read", "dashboards:edit"]

const document = Schema.decodeSync(DashboardDocument)({
	id: ROUTE.dashboardId,
	name: "Checkout",
	timeRange: { type: "relative", value: "6h" },
	widgets: [],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const readyAs = (grants: ReadonlyArray<Policy.Permission>, search: Model["search"] = {}): Model =>
	Arr.reduce(
		[
			Message.CompletedFetchSession({ orgId, grants }),
			Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		],
		init({ ...ROUTE, search }, context).model,
		(model, message) => pageUpdate(model, message).model,
	)

const withMoreMenuOpen = (model: Model): Model => ({
	...model,
	moreMenu: Menu.init(model.moreMenu.id, { isOpen: true }),
})

describe("a dashboard for a role without dashboards:edit", () => {
	test("reads the board with Edit, rename and the first widget locked, naming the permission", () => {
		const reader = readyAs(READER)
		scene(
			{ update: pageUpdate, view },
			given(reader),
			...mounted(),
			expectView(role("button", { name: "Edit dashboard" })).toBeDisabled(),
			expectView(role("button", { name: "Add your first widget" })).toBeDisabled(),
			expectView(role("group", { name: Policy.denialFor("dashboards:edit").message })).toExist(),
			expectView(role("button", { name: "Checkout" })).toHaveAttr("aria-disabled", "true"),
		)
		expect(pageUpdate(reader, Message.ClickedTitle()).model.titleDraft).toBeNull()
	})

	test("an edit link opens the board in view mode", () => {
		expect(isEditing(readyAs(READER, { mode: "edit" }))).toBe(false)
		const entered = routeChanged(readyAs(READER), { ...ROUTE, search: { mode: "edit" } }, context)
		expect(isEditing(entered.model)).toBe(false)
		expect(isEditing(readyAs(EDITOR_NO_SHARE, { mode: "edit" }))).toBe(true)
	})
})

describe("sharing a dashboard", () => {
	test("Share… is locked for a role without dashboards:share and open to one with it", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMoreMenuOpen(readyAs(EDITOR_NO_SHARE))),
			...mounted(),
			Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(role("menuitem", { name: "Share…" })).toHaveAttr("aria-disabled", "true"),
			expectView(role("button", { name: "Edit dashboard" })).toBeEnabled(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withMoreMenuOpen(readyAs(READER))),
			...mounted(),
			Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(role("menuitem", { name: "Share…" })).not.toHaveAttr("aria-disabled", "true"),
		)
	})
})
