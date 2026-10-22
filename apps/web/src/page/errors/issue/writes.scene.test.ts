import { OrgId } from "@maple/domain"
import { ErrorIssueEventsResponse, ErrorIssueId } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { pickedSeverity } from "./writes"

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
		expect(claiming.model.busy).toEqual(["claim"])
		expect(pageUpdate(claiming.model, Message.ClickedClaim()).commands).toBeUndefined()
		const done = pageUpdate(
			claiming.model,
			Message.CompletedIssueWrite({
				write: { _tag: "Claim" },
				result: Result.succeed({ severity: null }),
			}),
		)
		expect(done.model.busy).toEqual([])
		expect(done.outMessage).toMatchObject({ _tag: "RequestedToast", type: "success", title: "Claimed" })
		// Every invalidated read restarts, including the ones still in flight.
		expect(names(done.commands)).toEqual(
			expect.arrayContaining([
				"FetchErrorIssueDetail",
				"FetchErrorIssueEvents",
				"FetchErrorIssueEscalations",
				"FetchErrorIssuePullRequests",
				"FetchErrorIssueVerifications",
			]),
		)
	})

	test("a pre-write read landing after the write's re-read started is dropped", () => {
		const model = windowed()
		const staleKey = model.detail.key ?? ""
		const claiming = pageUpdate(model, Message.ClickedClaim()).model
		const done = pageUpdate(
			claiming,
			Message.CompletedIssueWrite({
				write: { _tag: "Claim" },
				result: Result.succeed({ severity: null }),
			}),
		).model
		expect(done.detail.key).not.toBe(staleKey)
		const late = pageUpdate(
			done,
			Message.CompletedFetchDetail({ key: staleKey, result: Result.fail(toLoadFailure("old")) }),
		)
		expect(late.model.detail).toEqual(done.detail)
	})

	test("writes of different kinds run side by side; a confirmed raise is never dropped", () => {
		const claiming = pageUpdate(windowed(), Message.ClickedClaim()).model
		const routed = pageUpdate(
			claiming,
			Message.CompletedEvaluateEscalation({
				severity: "high",
				pick: 0,
				result: Result.succeed({ outcome: "route", destinationIds: ["dest-1"] }),
			}),
		)
		const confirmed = pageUpdate(routed.model, Message.ClickedConfirmSeverity())
		expect(confirmed.commands?.find(({ name }) => name === "RunErrorIssueWrite")).toMatchObject({
			args: { write: { _tag: "SetSeverity", severity: "high" } },
		})
		expect(confirmed.model.busy).toEqual(["claim", "severity"])
		const claimed = pageUpdate(
			confirmed.model,
			Message.CompletedIssueWrite({
				write: { _tag: "Claim" },
				result: Result.succeed({ severity: null }),
			}),
		)
		expect(claimed.model.busy).toEqual(["severity"])
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
				pick: 0,
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
				pick: 0,
				result: Result.succeed({ outcome: "skip", destinationIds: [] }),
			}),
		)
		expect(skipped.model.busy).toEqual(["severity"])
		const failed = pageUpdate(
			windowed(),
			Message.CompletedEvaluateEscalation({
				severity: "low",
				pick: 0,
				result: Result.fail(toLoadFailure("boom")),
			}),
		)
		expect(failed.model.busy).toEqual([])
		expect(failed.outMessage).toMatchObject({ type: "error" })
	})

	test("two quick picks write the last one; the first pick's preview is dropped", () => {
		const skip = Result.succeed({ outcome: "skip", destinationIds: [] })
		const first = pickedSeverity(windowed(), "low")
		const second = pickedSeverity(first.model, "high")
		const pickOf = (step: typeof first) => Number(step.commands?.[0]?.args?.["pick"])
		const firstLanded = pageUpdate(
			second.model,
			Message.CompletedEvaluateEscalation({ severity: "low", pick: pickOf(first), result: skip }),
		)
		expect(firstLanded.model.busy).toEqual([])
		const secondLanded = pageUpdate(
			firstLanded.model,
			Message.CompletedEvaluateEscalation({ severity: "high", pick: pickOf(second), result: skip }),
		)
		expect(secondLanded.commands?.[0]).toMatchObject({
			name: "RunErrorIssueWrite",
			args: { write: { _tag: "SetSeverity", severity: "high" } },
		})
	})
})
