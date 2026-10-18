import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
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

const windowed = (search: Model["search"] = {}) =>
	pageUpdate(
		init({ toolName: "Bash", search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	)

describe("agent tool detail", () => {
	test("the window's reads go out with the tool pinned from the route", () => {
		const resolved = windowed({ tool: "Read" })
		expect(names(resolved.commands)).toEqual([
			"FetchAgentToolSeries",
			"FetchAgentToolTotals",
			"FetchAgentToolErrors",
			"FetchAgentToolSessions",
			"FetchAgentToolFacets",
		])
		expect(resolved.model.totals.key).toContain("Bash")
	})

	test("a stale errors answer is dropped", () => {
		const resolved = windowed().model
		const late = pageUpdate(resolved, Message.CompletedFetchErrors({ key: "old", result: Result.succeed({ data: [] }) }))
		expect(AsyncData.isLoading(late.model.errors.data)).toBe(true)
	})

	test("an error row opens its group through the URL, dropping the last group's narrowing", () => {
		const model = windowed({ session: "s1", variant: "v1" }).model
		expect(pageUpdate(model, Message.ClickedErrorRow({ fingerprint: "42" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/agent-sessions/tools/Bash?error=%2242%22", isReplace: false }),
		)
	})

	test("the errors table sorts locally and folds its long tail", () => {
		const model = windowed().model
		const sorted = pageUpdate(model, Message.ClickedErrorsSort({ key: "sessions" }))
		expect(sorted.model.errorsSort).toEqual({ key: "sessions", dir: "desc" })
		expect(pageUpdate(model, Message.ToggledErrorsExpanded()).model.isErrorsExpanded).toBe(true)
	})
})
