import { OrgId } from "@maple/domain"
import { V2ErrorIssue } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as ContextMenu from "@maple/views/ui/context-menu"
import { MeasureTabIndicator, Message as TabsMessage } from "@maple/views/ui/tabs"
import type { PageContext } from "../../contract"
import { MountFilterRail, MountRowSelect } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// An analyst reads the list; selection, the row pickers, the bulk bar and the row menu's
// status and lease entries need `error_issues:triage`.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const MEMBER = Policy.grantsOf(["org:member"])
const ANALYST = Policy.grantsOf(["org:analyst"])

const RECT = { left: 2, right: 115, top: 2, bottom: 2, width: 51, height: 28 }
const mounted = [
	Mount.resolve(MeasureTabIndicator, TabsMessage.MeasuredIndicator({ rect: RECT })),
	Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
	Mount.resolve(MountRowSelect, Message.ClickedRowSelect({ id: "", isShift: false })),
] as const

const ISSUE_ID = "0199a004-0000-7000-8000-000000000001"
const issue = Schema.decodeSync(V2ErrorIssue)({
	id: "iss_YoxMYDoXSr3tsBZyBLmNMv",
	object: "error_issue",
	kind: "error",
	fingerprint_hash: "12660752272409977512",
	service_name: "payment-svc",
	exception_type: "ConnectionTimeout",
	exception_message: "timed out acquiring a connection",
	error_label: "ConnectionTimeout",
	top_frame: "",
	workflow_state: "triage",
	priority: 1,
	severity: "critical",
	severity_source: "detector",
	source_ref: null,
	assigned_actor: null,
	lease_holder: null,
	lease_expires_at: null,
	claimed_at: null,
	notes: null,
	first_seen_at: "2026-10-01T10:00:00.000Z",
	last_seen_at: "2026-10-01T11:44:00.000Z",
	occurrence_count: 12,
	resolved_at: null,
	last_resolved_at: null,
	last_regressed_at: null,
	regression_count: 0,
	resolved_versions: [],
	snooze_until: null,
	archived_at: null,
	has_open_incident: false,
	comment_count: 0,
	open_pull_request_count: 0,
	merged_pull_request_count: 0,
})

/** Entered with the session's grants, its window and one row. */
const loaded = (grants: ReadonlyArray<Policy.Permission>): Model => {
	const windowed = Arr.reduce(
		[
			Message.CompletedFetchSession({ orgId, grants }),
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
			Message.MountedFilterRail(),
		],
		init({ search: {} }, context).model,
		(model, message) => pageUpdate(model, message).model,
	)
	return pageUpdate(
		windowed,
		Message.CompletedFetchPage({
			key: windowed.pages[0]?.page.key ?? "",
			result: Result.succeed({ data: [issue], hasMore: false, nextCursor: null }),
		}),
	).model
}

const press = (model: Model, key: string): Model =>
	pageUpdate(model, Message.PressedListKey({ key, isShift: false })).model

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

/** The row's right-click menu, opened and its entry at `index` picked. */
const pickedFromRowMenu = (model: Model, index: number) => {
	const opened = pageUpdate(model, Message.OpenedRowMenu({ id: ISSUE_ID })).model
	return pageUpdate(
		opened,
		Message.GotRowMenuMessage({ message: ContextMenu.Message.ClickedItem({ index }) }),
	)
}

describe("errors list for an analyst", () => {
	test("a row reads its severity and status with no checkbox or picker", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ANALYST)),
			...mounted,
			expectView(role("link", { name: /ConnectionTimeout/ })).toHaveAttr(
				"href",
				`/errors/issues/${ISSUE_ID}`,
			),
			expectView(role("img", { name: "Critical" })).toExist(),
			expectView(text("Triage")).toExist(),
			expectView(role("checkbox")).toBeAbsent(),
			expectView(role("button", { name: /Change severity/ })).toBeAbsent(),
			expectView(role("button", { name: "Triage" })).toBeAbsent(),
		)
	})

	test("a member gets the checkboxes and both pickers", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(MEMBER)),
			...mounted,
			expectView(role("checkbox", { name: "Select all errors" })).toExist(),
			expectView(role("checkbox", { name: "Select this error" })).toExist(),
			expectView(role("button", { name: /Change severity/ })).toExist(),
			expectView(role("button", { name: "Triage" })).toExist(),
		)
	})

	test("a selection brings a member the bulk bar and an analyst nothing", () => {
		const bulkBar = role("region", { name: "Bulk actions" })
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded(MEMBER), selectedIds: [ISSUE_ID] }),
			...mounted,
			expectView(bulkBar).toExist(),
			expectView(role("button", { name: "Claim" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded(ANALYST), selectedIds: [ISSUE_ID] }),
			...mounted,
			expectView(bulkBar).toBeAbsent(),
			expectView(role("button", { name: "Claim" })).toBeAbsent(),
		)
	})

	test("x, s and p do nothing; j still moves the focus and Enter opens the issue", () => {
		const focused = press(loaded(ANALYST), "j")
		expect(focused.focusedId).toBe(ISSUE_ID)
		expect(press(focused, "x").selectedIds).toEqual([])
		expect(press(focused, "s").picker).toBeNull()
		expect(press(focused, "p").picker).toBeNull()
		expect(
			pageUpdate(focused, Message.PressedListKey({ key: "Enter", isShift: false })).outMessage,
		).toMatchObject({ _tag: "RequestedNavigation", url: `/errors/issues/${ISSUE_ID}` })
	})

	test("for a member x selects and s and p open the row's pickers", () => {
		const focused = press(loaded(MEMBER), "j")
		expect(press(focused, "x").selectedIds).toEqual([ISSUE_ID])
		expect(press(focused, "s").picker).toMatchObject({ issueId: ISSUE_ID, kind: "state" })
		expect(press(focused, "p").picker).toMatchObject({ issueId: ISSUE_ID, kind: "severity" })
	})

	test("the row menu starts at Open in new tab and writes nothing", () => {
		expect(names(pickedFromRowMenu(loaded(ANALYST), 0).commands)).toContain("OpenErrorsRowInNewTab")
		// Where a member's menu has Claim, an analyst's has Copy link.
		const second = names(pickedFromRowMenu(loaded(ANALYST), 1).commands)
		expect(second).toContain("CopyErrorsRowText")
		expect(second).not.toContain("RunErrorsHubWrite")
	})

	test("a member's row menu claims the issue", () => {
		expect(names(pickedFromRowMenu(loaded(MEMBER), 1).commands)).toContain("RunErrorsHubWrite")
	})

	test("grants answered for another org are dropped", () => {
		const other = Schema.decodeSync(OrgId)("org_other")
		const model = pageUpdate(
			loaded(MEMBER),
			Message.CompletedFetchSession({ orgId: other, grants: ANALYST }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			...mounted,
			expectView(role("checkbox", { name: "Select this error" })).toExist(),
		)
	})
})
