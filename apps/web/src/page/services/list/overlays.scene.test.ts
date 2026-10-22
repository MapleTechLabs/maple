import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as HoverCard from "../../../ui/hover-card"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, preload, update } from "./update"
import { overlayTriggerId } from "./update-overlays"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const SHA = "4f1c2a9be07d3c5a8e61f2b9d0c47a3e5b8f1d26"
const trigger = overlayTriggerId("commit", "storefront--production", SHA)

const entered = (): Model => init({ search: {} }, context).model
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const enter = (model: Model) =>
	pageUpdate(
		model,
		Message.GotCommitCardMessage({ message: HoverCard.Message.EnteredTrigger({ triggerId: trigger }) }),
	)

describe("services list overlays", () => {
	test("hovering a deploy arms the commit lookup, which starts 20 ms later", () => {
		const hovered = enter(entered())
		expect(names(hovered.commands)).toContain("ArmServicesCommitLookup")
		const armed = pageUpdate(
			hovered.model,
			Message.ElapsedCommitArm({ sha: SHA, generation: hovered.model.commitArm }),
		)
		expect(names(armed.commands)).toEqual(["FetchServicesCommitDetail"])
		expect(AsyncData.isLoading(armed.model.commitDetails[SHA] ?? AsyncData.Idle())).toBe(true)
	})

	test("leaving before the arm fires sends nothing, and a looked-up commit is not fetched again", () => {
		const hovered = enter(entered())
		const left = pageUpdate(
			hovered.model,
			Message.GotCommitCardMessage({ message: HoverCard.Message.LeftTrigger() }),
		)
		const stale = pageUpdate(
			left.model,
			Message.ElapsedCommitArm({ sha: SHA, generation: hovered.model.commitArm }),
		)
		expect(names(stale.commands)).toEqual([])
		const looked = pageUpdate(
			left.model,
			Message.CompletedFetchCommitDetail({
				sha: SHA,
				result: Result.fail({ tag: "VcsCommitNotFoundError" }),
			}),
		)
		expect(names(enter(looked.model).commands)).toEqual(["WaitHoverDelay"])
	})

	test("copying the sha writes the clipboard, then opens the row with the write's toast", () => {
		const url = "/services/storefront?environments=%5B%22production%22%5D"
		const copied = pageUpdate(
			entered(),
			Message.ClickedCopyCommitSha({ sha: SHA, serviceName: "storefront", environment: "production" }),
		)
		expect(names(copied.commands)).toEqual(["CopyServicesCommitSha"])
		expect(copied.outMessage).toBeUndefined()
		const landed = (isCopied: boolean) =>
			pageUpdate(copied.model, Message.CompletedCopyCommitSha({ rowUrl: url, isCopied })).outMessage
		expect(landed(true)).toMatchObject({
			_tag: "RequestedNavigation",
			url,
			toast: { type: "success", title: "commit SHA copied" },
		})
		expect(landed(false)).toMatchObject({
			_tag: "RequestedNavigation",
			url,
			toast: { type: "error", title: "Failed to copy commit sha" },
		})
	})

	test("link intent warms the keys the pinned page reads", () => {
		const pinned = { ...context, pinnedNamespace: "shop" }
		const nowMs = Date.UTC(2026, 9, 1, 12)
		const commands = preload({ search: {} }, pinned, nowMs)
		expect(names(commands)).toEqual(
			expect.arrayContaining(["FetchServiceOverview", "FetchServiceSparklines", "FetchServicesFacets"]),
		)
		const opened = update(
			init({ search: {} }, pinned).model,
			Message.CompletedResolveWindow({
				window: { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" },
				nowMs,
				mode: "Load",
			}),
			pinned,
		).commands
		const keysOf = (list: typeof commands | undefined) =>
			(list ?? []).flatMap((command) =>
				command.args !== undefined && "key" in command.args && typeof command.args.key === "string"
					? [command.args.key]
					: [],
			)
		expect(keysOf(commands)).toHaveLength(3)
		expect(keysOf(opened)).toEqual(expect.arrayContaining(keysOf(commands)))
	})
})
