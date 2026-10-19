import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { arrowStepOf } from "./error-modal-command"
import * as ErrorModal from "./error-modal-model"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-25 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const modal = (message: ErrorModal.Message) => Message.GotErrorModalMessage({ message })

const group = (fingerprint: string) => ({
	fingerprint,
	errorType: "",
	message: "1 failed: expected 2 attempts, received 1",
	calls: 1,
	sessions: 1,
	variants: 1,
	firstSeen: NOW - 3_600_000,
	lastSeen: NOW - 3_600_000,
	callsSince: 2,
	trend: [],
})

const occurrence = (spanId: string) => ({
	timestamp: NOW - 3_600_000,
	traceId: "trace-1",
	spanId,
	sessionId: "s1",
	vendorId: "claude_code",
	agentName: "",
	model: "claude-opus-4-1",
	service: "claude-code",
	errorType: "",
	message: "1 failed",
	durationNs: 8_400_000_000,
	statusCode: "Error",
	arguments: '{"command":"bun run test"}',
	argumentsBytes: 26,
	result: "",
	resultBytes: 0,
})

/** The page on `search`, its window resolved and its Errors read answered with groups `42` and `43`. */
const withErrors = (search: Model["search"]) => {
	const resolved = pageUpdate(
		init({ toolName: "Bash", search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(
		resolved,
		Message.CompletedFetchErrors({
			key: resolved.errors.key ?? "",
			result: Result.succeed({ data: [group("42"), group("43")] }),
		}),
	)
}

describe("agent tool error modal", () => {
	test("opens on the row the URL names, reading its facts and first page of samples once", () => {
		const opened = withErrors({ error: "42" })
		expect(opened.model.errorModal.dialog.isOpen).toBe(true)
		expect(names(opened.commands)).toEqual(
			expect.arrayContaining(["FetchAgentToolErrorDetail", "FetchAgentToolErrorSamples"]),
		)
		expect(names(pageUpdate(opened.model, modal(ErrorModal.Message.ClickedCopyLink())).commands)).toEqual([
			"CopyAgentToolErrorLink",
		])
	})

	test("a stale ?error= the window no longer holds opens nothing and reads nothing", () => {
		const stale = withErrors({ error: "99" })
		expect(stale.model.errorModal.dialog.isOpen).toBe(false)
		expect(names(stale.commands)).not.toContain("FetchAgentToolErrorDetail")
	})

	test("the next page is read past the last sample, and the open sample moves with j", () => {
		const opened = withErrors({ error: "42" }).model
		const key = opened.errorModal.pages[0]?.key ?? ""
		const cursor = { timestamp: "2026-10-01 11:00:00", spanId: "b" }
		const landed = pageUpdate(
			opened,
			modal(
				ErrorModal.Message.CompletedFetchSamples({
					key,
					result: Result.succeed({ occurrences: [occurrence("a"), occurrence("b")], nextCursor: cursor }),
				}),
			),
		).model
		const next = pageUpdate(landed, modal(ErrorModal.Message.PressedModalKey({ key: "OlderSample" })))
		expect(next.model.errorModal.selected).toBe(1)
		const more = pageUpdate(next.model, modal(ErrorModal.Message.PressedModalKey({ key: "OlderSample" })))
		expect(names(more.commands)).toContain("FetchAgentToolErrorSamples")
		expect(more.model.errorModal.pages).toHaveLength(2)
	})

	test("↓ opens the next group, dropping the narrowing; Close drops the group from the URL", () => {
		const opened = withErrors({ error: "42", session: "s1" }).model
		expect(pageUpdate(opened, modal(ErrorModal.Message.PressedModalKey({ key: "StepDown" }))).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/agent-sessions/tools/Bash?error=%2243%22", isReplace: false }),
		)
		const closed = pageUpdate(opened, modal(ErrorModal.Message.ClickedClose()))
		expect(closed.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/agent-sessions/tools/Bash", isReplace: false }),
		)
		expect(closed.model.errorModal.dialog.isOpen).toBe(false)
	})

	test("↑/↓ claim the key only when they step: past either end the scroll area keeps it", () => {
		expect(arrowStepOf("ArrowUp", { index: 0, total: 2 })).toEqual(Option.none())
		expect(arrowStepOf("ArrowDown", { index: 0, total: 2 })).toEqual(Option.some("StepDown"))
		expect(arrowStepOf("ArrowUp", { index: 1, total: 2 })).toEqual(Option.some("StepUp"))
		expect(arrowStepOf("ArrowDown", { index: 1, total: 2 })).toEqual(Option.none())
		expect(arrowStepOf("j", { index: 0, total: 2 })).toEqual(Option.none())
	})

	test("Reload re-reads the open group's facts even when the window is unchanged", () => {
		const opened = withErrors({ error: "42" }).model
		const answered = pageUpdate(
			opened,
			modal(
				ErrorModal.Message.CompletedFetchDetail({
					key: opened.errorModal.detail.key ?? "",
					result: Result.succeed({ sessions: [], variants: [], breakdown: [] }),
				}),
			),
		).model
		const reloaded = pageUpdate(answered, Message.ClickedReload()).model
		const resolved = pageUpdate(reloaded, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Refresh" }))
		expect(names(resolved.commands)).toContain("FetchAgentToolErrorDetail")
	})
})
