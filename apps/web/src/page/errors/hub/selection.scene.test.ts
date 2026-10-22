import { OrgId } from "@maple/domain"
import { V2ErrorIssue } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const ids = ["iss_YoxMYDoXSr3tsBZyBLmNMv", "iss_YoxMYDoXSr3tsBZyBLmNMw", "iss_YoxMYDoXSr3tsBZyBLmNMx"]
const issue = (id: string, lastSeen: string) =>
	Schema.decodeUnknownSync(V2ErrorIssue)({
		id,
		object: "error_issue",
		kind: "error",
		fingerprint_hash: "1",
		service_name: "payment-svc",
		exception_type: "ConnectionTimeout",
		exception_message: "timed out",
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
		last_seen_at: lastSeen,
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

/** Three rows, newest first in this order. */
const loaded = (): Model => {
	const entered = init({ search: {} }, context).model
	const model = pageUpdate(
		entered,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	).model
	const data = ids.map((id, index) => issue(id, `2026-10-01T11:4${5 - index}:00.000Z`))
	return pageUpdate(
		model,
		Message.CompletedFetchPage({
			key: model.pages[0]?.page.key ?? "",
			result: Result.succeed({ data, hasMore: false, nextCursor: null }),
		}),
	).model
}

const internalIds = (model: Model) => model.selectedIds

describe("errors hub selection", () => {
	test("Shift extends from the anchor to the clicked row", () => {
		const press = (model: Model, key: string, isShift = false) =>
			pageUpdate(model, Message.PressedListKey({ key, isShift })).model
		const anchored = press(press(loaded(), "j"), "x")
		const last = press(press(anchored, "j"), "j")
		const ranged = pageUpdate(
			last,
			Message.ClickedRowSelect({ id: last.focusedId ?? "", isShift: true }),
		).model
		expect(internalIds(ranged)).toHaveLength(3)
		const plain = pageUpdate(
			last,
			Message.ClickedRowSelect({ id: last.focusedId ?? "", isShift: false }),
		).model
		expect(internalIds(plain)).toHaveLength(2)
	})

	test("j moves the focus down, x selects it, Escape clears the selection first", () => {
		const model = loaded()
		const focused = pageUpdate(
			pageUpdate(model, Message.PressedListKey({ key: "j", isShift: false })).model,
			Message.PressedListKey({ key: "j", isShift: false }),
		).model
		expect(focused.focusedId).not.toBeNull()
		const selected = pageUpdate(focused, Message.PressedListKey({ key: "x", isShift: false })).model
		expect(selected.selectedIds).toEqual([focused.focusedId])
		const escaped = pageUpdate(selected, Message.PressedListKey({ key: "Escape", isShift: false })).model
		expect(escaped.selectedIds).toEqual([])
		expect(escaped.focusedId).toBe(focused.focusedId)
	})

	test("Enter on a focused row navigates to the issue", () => {
		const focused = pageUpdate(loaded(), Message.PressedListKey({ key: "j", isShift: false })).model
		const opened = pageUpdate(focused, Message.PressedListKey({ key: "Enter", isShift: false }))
		expect(opened.outMessage).toMatchObject({ _tag: "RequestedNavigation" })
	})

	test("bulk Claim writes the selection once and clears it; the outcome re-reads the list", () => {
		const model = loaded()
		const a = pageUpdate(model, Message.PressedListKey({ key: "j", isShift: false })).model
		const selected = pageUpdate(a, Message.PressedListKey({ key: "x", isShift: false })).model
		const claiming = pageUpdate(selected, Message.ClickedBulkClaim())
		expect(names(claiming.commands)).toEqual(["RunErrorsHubWrite"])
		expect(claiming.model.selectedIds).toEqual([])
		const done = pageUpdate(
			claiming.model,
			Message.CompletedHubWrite({
				ids: claiming.model.writingIds,
				write: { _tag: "Claim" },
				isBulk: true,
				outcome: { succeeded: 1, failed: 0, firstFailure: null },
			}),
		)
		expect(done.outMessage).toMatchObject({ type: "success", title: "Claimed 1 issue" })
		expect(names(done.commands)).toContain("FetchErrorIssuesPage")
		expect(done.model.writingIds).toEqual([])
	})

	test("a row still being written is written again: the newest pick is sent, not dropped", () => {
		const press = (model: Model, key: string) =>
			pageUpdate(model, Message.PressedListKey({ key, isShift: false })).model
		const selected = press(press(loaded(), "j"), "x")
		const first = pageUpdate(selected, Message.ClickedBulkClaim()).model
		const again = pageUpdate(press(first, "x"), Message.ClickedBulkClaim())
		expect(names(again.commands)).toEqual(["RunErrorsHubWrite"])
		const done = pageUpdate(
			again.model,
			Message.CompletedHubWrite({
				ids: [selected.focusedId ?? ""],
				write: { _tag: "Claim" },
				isBulk: true,
				outcome: { succeeded: 1, failed: 0, firstFailure: null },
			}),
		)
		expect(done.model.writingIds).toEqual([selected.focusedId])
	})

	test("a single row's write keeps the selection: only the bulk bar clears it", () => {
		const press = (model: Model, key: string) =>
			pageUpdate(model, Message.PressedListKey({ key, isShift: false })).model
		const selected = press(press(press(press(loaded(), "j"), "x"), "j"), "x")
		expect(selected.selectedIds).toHaveLength(2)
		const done = pageUpdate(
			selected,
			Message.CompletedHubWrite({
				ids: [ids[2] ?? ""],
				write: { _tag: "Claim" },
				isBulk: false,
				outcome: { succeeded: 1, failed: 0, firstFailure: null },
			}),
		)
		expect(names(done.commands)).toContain("FetchErrorIssuesPage")
		expect(done.model.selectedIds).toEqual(selected.selectedIds)
	})

	test("a second write's refresh restarts the first one's re-read, whose late answer is dropped", () => {
		const completed = (model: Model, id: string) =>
			pageUpdate(
				model,
				Message.CompletedHubWrite({
					ids: [id],
					write: { _tag: "Claim" },
					isBulk: false,
					outcome: { succeeded: 1, failed: 0, firstFailure: null },
				}),
			)
		const first = completed(loaded(), ids[0] ?? "")
		const second = completed(first.model, ids[1] ?? "")
		expect(names(second.commands)).toContain("FetchErrorIssuesPage")
		const firstKey = first.model.pages[0]?.page.key ?? ""
		expect(second.model.pages[0]?.page.key).not.toBe(firstKey)
		const late = pageUpdate(
			second.model,
			Message.CompletedFetchPage({ key: firstKey, result: Result.fail(toLoadFailure("old")) }),
		)
		expect(late.model.pages).toEqual(second.model.pages)
	})
})
