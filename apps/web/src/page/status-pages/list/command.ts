import { readClock } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { StatusPageId } from "@maple/domain"
import { computeOrgKey, deletePage, listPageSummaries } from "../shared/commands"
import { Message } from "./message"
import { fetchSessionGrants } from "../../kit/session-grants"

export const ReadListClock = readClock("ReadStatusPagesClock", Message.ReadClock)

export const ComputeListOrgKey = computeOrgKey("ComputeStatusPagesOrgKey", Message.ComputedOrgKey)

export const FetchListSession = fetchSessionGrants("FetchStatusPagesSession", Message.CompletedFetchSession)

export const FetchStatusPages = Command.define("FetchStatusPageSummaries", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchPages],
	execute: ({ key }) =>
		listPageSummaries.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPages({ key, result })),
		),
})

/** The public page in a new tab: a menu item has no `<a>` to carry `target="_blank"`. */
export const OpenPageInNewTab = Command.define("OpenStatusPageInNewTab", {
	args: { url: Schema.String },
	messages: [Message.CompletedOpenPage],
	execute: ({ url }) =>
		Effect.sync(() => {
			window.open(url, "_blank", "noopener,noreferrer")
			return Message.CompletedOpenPage()
		}),
})

export const DeleteListedPage = Command.define("DeleteListedStatusPage", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedDelete],
	execute: ({ pageId }) =>
		deletePage(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDelete({ result })),
		),
})
