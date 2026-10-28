import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { describe, expect, test } from "vitest"
import * as RadioGroup from "../../../ui/radio-group"
import { type PageContext } from "../../contract"
import { FetchShares } from "./command"
import { WriteShare } from "./command-share"
import { Message } from "./message"
import type { Model } from "./model"
import { ShareMessage } from "./share"
import { openEmbed, openShare } from "./share-update"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const share = (message: ShareMessage) => Message.GotShareMessage({ message })
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_share",
	name: "Share",
	timeRange: { type: "relative", value: "6h" },
	widgets: [],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const withShares = (rows: ReadonlyArray<{ widgetId: string | null; mode: "public" | "org"; token: string }>): Model =>
	[
		Message.CompletedReadClock({ nowMs: 0 }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		share(ShareMessage.CompletedFetchShares({ seq: 1, result: Result.succeed(rows) })),
	].reduce((model, message) => pageUpdate(model, message).model, init({ dashboardId: "dash_share", search: {} }, context).model)

describe("dashboard sharing", () => {
	test("a picked access writes once and holds the pick until the list confirms it", () => {
		const opened = openShare(withShares([])).model
		const picked = pageUpdate(opened, share(ShareMessage.GotAccessMessage({ message: RadioGroup.Message.SelectedRadio({ value: "public" }) })))
		expect(names(picked.commands)).toEqual([WriteShare.name])
		expect(picked.model.sharing.pendingAccess).toBe("public")
		const again = pageUpdate(picked.model, share(ShareMessage.GotAccessMessage({ message: RadioGroup.Message.SelectedRadio({ value: "org" }) })))
		expect(names(again.commands)).toEqual([])
		const written = pageUpdate(picked.model, share(ShareMessage.CompletedWrite({ error: null })))
		expect(names(written.commands)).toEqual([FetchShares.name])
		const listed = pageUpdate(
			written.model,
			share(ShareMessage.CompletedFetchShares({ seq: 2, result: Result.succeed([{ widgetId: null, mode: "public", token: "t" }]) })),
		)
		expect(listed.model.sharing.pendingAccess).toBeNull()
	})

	test("a failed write drops the pick and shows the error", () => {
		const opened = openShare(withShares([])).model
		const picked = pageUpdate(opened, share(ShareMessage.GotAccessMessage({ message: RadioGroup.Message.SelectedRadio({ value: "org" }) })))
		const failed = pageUpdate(picked.model, share(ShareMessage.CompletedWrite({ error: "Nope" })))
		expect(failed.model.sharing.pendingAccess).toBeNull()
		expect(failed.model.sharing.error).toBe("Nope")
	})

	test("embedding on a public board mints the chart link; making a board public mints it after", () => {
		const minted = openEmbed(withShares([{ widgetId: null, mode: "public", token: "t" }]), "w1")
		expect(names(minted.commands)).toContain(WriteShare.name)
		const orgOnly = openEmbed(withShares([{ widgetId: null, mode: "org", token: "t" }]), "w1")
		expect(names(orgOnly.commands)).not.toContain(WriteShare.name)
		const made = pageUpdate(orgOnly.model, share(ShareMessage.ClickedMakePublic()))
		expect(names(made.commands)).toEqual([WriteShare.name])
		const boardDone = pageUpdate(made.model, share(ShareMessage.CompletedWrite({ error: null })))
		expect(names(boardDone.commands)).toEqual(expect.arrayContaining([FetchShares.name, WriteShare.name]))
	})

	test("a list read answered after a newer one is dropped", () => {
		const orgOnly = openEmbed(withShares([{ widgetId: null, mode: "org", token: "t" }]), "w1").model
		const made = pageUpdate(orgOnly, share(ShareMessage.ClickedMakePublic())).model
		const boardDone = pageUpdate(made, share(ShareMessage.CompletedWrite({ error: null }))).model
		const minted = pageUpdate(boardDone, share(ShareMessage.CompletedWrite({ error: null }))).model
		const rows = [{ widgetId: null, mode: "public" as const, token: "t" }, { widgetId: "w1", mode: "public" as const, token: "c" }]
		const latest = pageUpdate(minted, share(ShareMessage.CompletedFetchShares({ seq: 3, result: Result.succeed(rows) }))).model
		const stale = pageUpdate(latest, share(ShareMessage.CompletedFetchShares({ seq: 2, result: Result.succeed(rows.slice(0, 1)) }))).model
		expect(AsyncData.getOrElse(stale.sharing.shares, () => [])).toHaveLength(2)
	})

	test("Embed chart opens over a list that failed to re-read, without minting", () => {
		const failed = pageUpdate(
			withShares([{ widgetId: null, mode: "public", token: "t" }]),
			share(ShareMessage.CompletedFetchShares({ seq: 1, result: Result.fail(toLoadFailure("down")) })),
		).model
		const opened = openEmbed(failed, "w1")
		expect(opened.model.sharing.embedDialog.isOpen).toBe(true)
		expect(names(opened.commands)).not.toContain(WriteShare.name)
	})
})
