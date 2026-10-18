import { OrgId } from "@maple/domain"
import { ErrorIssueEventsResponse, ErrorIssueId } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const windowed = (): Model =>
	pageUpdate(
		init({ issueId, search: {} }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	).model

describe("error issue writes", () => {
	test("Claim writes once while in flight, then toasts and re-reads what it invalidated", () => {
		const model = windowed()
		const settled = pageUpdate(
			model,
			Message.CompletedFetchEvents({
				key: model.events.key ?? "",
				result: Result.succeed(new ErrorIssueEventsResponse({ events: [] })),
			}),
		).model
		const claiming = pageUpdate(settled, Message.ClickedClaim())
		expect(names(claiming.commands)).toEqual(["RunErrorIssueWrite"])
		expect(claiming.model.busy).toBe("claim")
		expect(pageUpdate(claiming.model, Message.ClickedClaim()).commands).toBeUndefined()
		const done = pageUpdate(
			claiming.model,
			Message.CompletedIssueWrite({
				write: { _tag: "Claim" },
				result: Result.succeed({ severity: null }),
			}),
		)
		expect(done.model.busy).toBeNull()
		expect(done.outMessage).toMatchObject({ _tag: "RequestedToast", type: "success", title: "Claimed" })
		// Reads still in flight are not asked twice; the settled timeline is re-read.
		expect(names(done.commands)).toEqual(["FetchErrorIssueEvents"])
	})

	test("a failed write toasts the error and re-reads nothing", () => {
		const done = pageUpdate(
			pageUpdate(windowed(), Message.ClickedReleaseLease()).model,
			Message.CompletedIssueWrite({
				write: { _tag: "Release" },
				result: Result.fail(toLoadFailure("boom")),
			}),
		)
		expect(done.outMessage).toMatchObject({ type: "error", title: "Failed to release issue" })
		expect(done.commands ?? []).toEqual([])
	})

	test("a routed severity raise waits on the confirmation, then writes", () => {
		const routed = pageUpdate(
			windowed(),
			Message.CompletedEvaluateEscalation({
				severity: "high",
				result: Result.succeed({ outcome: "route", destinationIds: ["dest-1"] }),
			}),
		)
		expect(routed.model.pendingSeverity).toEqual({ severity: "high", destinationNames: ["dest-1"] })
		expect(routed.model.severityConfirm.isOpen).toBe(true)
		const confirmed = pageUpdate(routed.model, Message.ClickedConfirmSeverity())
		expect(names(confirmed.commands)).toContain("RunErrorIssueWrite")
		expect(confirmed.model.pendingSeverity).toBeNull()
	})

	test("an unrouted raise writes at once; a failed preview changes nothing", () => {
		const skipped = pageUpdate(
			windowed(),
			Message.CompletedEvaluateEscalation({
				severity: "low",
				result: Result.succeed({ outcome: "skip", destinationIds: [] }),
			}),
		)
		expect(skipped.model.busy).toBe("severity")
		const failed = pageUpdate(
			windowed(),
			Message.CompletedEvaluateEscalation({
				severity: "low",
				result: Result.fail(toLoadFailure("boom")),
			}),
		)
		expect(failed.model.busy).toBeNull()
		expect(failed.outMessage).toMatchObject({ type: "error" })
	})
})
