import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import { Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import * as Menu from "@maple/views/ui/menu"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { ListDashboard, Model } from "./model"
import { init, rowMenuIdOf, update } from "./update"
import { view as pageView } from "./view"

// An analyst reads the list; creating, importing and the row's writes need `dashboards:edit`.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const board: ListDashboard = {
	id: "dash_platform",
	name: "Platform overview",
	description: "Cross-service health.",
	tags: [],
	widgetCount: 5,
	readsShort: "Traces · Errors",
	readsFull: "Traces · Errors",
	glyph: "PulseIcon",
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
}

const MEMBER = Policy.grantsOf(["org:member"])
const ANALYST = Policy.grantsOf(["org:analyst"])

/** Entered with its clock, preferences, the session's grants and rows. */
const loaded = (grants: ReadonlyArray<Policy.Permission>, dashboards: ReadonlyArray<ListDashboard>): Model =>
	Arr.reduce(
		[
			Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z"), locale: "en-US" }),
			Message.CompletedLoadPreferences({ favorites: [], sort: "updated" }),
			Message.CompletedFetchSession({ orgId, grants }),
			Message.UpdatedDashboards({ orgId, dashboards }),
		],
		init({ search: {} }, context).model,
		(model, message) => pageUpdate(model, message).model,
	)

const withRowMenuOpen = (model: Model): Model => ({
	...model,
	rowMenuId: board.id,
	rowMenu: Menu.init(rowMenuIdOf(board.id), { isOpen: true }),
})

describe("dashboards list for an analyst", () => {
	test("the header keeps Browse templates and drops Import and Create", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ANALYST, [board])),
			expectView(text("Platform overview")).toExist(),
			expectView(role("button", { name: "Browse templates" })).toExist(),
			expectView(role("button", { name: "Import" })).toBeAbsent(),
			expectView(role("button", { name: "Create dashboard" })).toBeAbsent(),
			expectView(text("New dashboard")).toBeAbsent(),
		)
	})

	test("a member gets Import, Create and the New dashboard row", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(MEMBER, [board])),
			expectView(role("button", { name: "Import" })).toExist(),
			expectView(role("button", { name: "Create dashboard" })).toExist(),
			expectView(text("New dashboard")).toExist(),
		)
	})

	test("the row menu exports and offers no write", () => {
		scene(
			{ update: pageUpdate, view },
			given(withRowMenuOpen(loaded(ANALYST, [board]))),
			Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(role("menuitem", { name: "Export JSON" })).toExist(),
			expectView(role("menuitem", { name: "Duplicate" })).toBeAbsent(),
			expectView(role("menuitem", { name: "Edit tags…" })).toBeAbsent(),
			expectView(role("menuitem", { name: "Delete" })).toBeAbsent(),
		)
	})

	test("a member's row menu duplicates, tags and deletes", () => {
		scene(
			{ update: pageUpdate, view },
			given(withRowMenuOpen(loaded(MEMBER, [board]))),
			Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(role("menuitem", { name: "Duplicate" })).toExist(),
			expectView(role("menuitem", { name: "Edit tags…" })).toExist(),
			expectView(role("menuitem", { name: "Delete" })).toExist(),
		)
	})

	test("an empty org offers nothing to create", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ANALYST, [])),
			expectView(text("No dashboards yet")).toExist(),
			expectView(role("button", { name: "Create blank dashboard" })).toBeAbsent(),
		)
	})

	test("grants answered for another org are dropped", () => {
		const other = Schema.decodeSync(OrgId)("org_other")
		const model = pageUpdate(
			loaded(MEMBER, [board]),
			Message.CompletedFetchSession({ orgId: other, grants: ANALYST }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("button", { name: "Create dashboard" })).toExist(),
		)
	})
})
