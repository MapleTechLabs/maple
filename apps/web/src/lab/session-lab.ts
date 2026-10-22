import { OrgId } from "@maple/domain"
import { AiSessionSpan } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { AsyncData, type Command, Submodel } from "foldkit"
import { fromString } from "foldkit/url"
import type { PageContext, PageOutMessage } from "../page/contract"
import { sessionData } from "../page/agent-sessions/session/derive"
import { Message as SessionMessage } from "../page/agent-sessions/session/message"
import type { Model as SessionModel } from "../page/agent-sessions/session/model"
import {
	init as sessionInit,
	routeChanged as sessionRouteChanged,
	update as sessionUpdate,
} from "../page/agent-sessions/session/update"
import { views } from "../page/agent-sessions/session/view"
import { sessionHeader } from "../page/agent-sessions/session/view-header"
import type { Resources } from "../platform/resources"
import { urlToAppRoute } from "../route"

// The session page driven by a fixture, for `/lab/agent-session` and `/lab/bench/agent-transcript`:
// the spans stand in for the warehouse, the lab's state for the URL.

type SessionCommands = ReadonlyArray<Command.Command<SessionMessage, never, Resources>>
export type SessionStep = Readonly<{ session: SessionModel; commands: SessionCommands }>

const READS = new Set(["FetchAgentSessionFirstPage", "FetchAgentSessionMorePage", "FetchAgentSessionTotals"])

const contextOf = (timeZone: string): PageContext => ({
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone,
})

const decodeSpan = Schema.decodeUnknownOption(Schema.fromJsonString(AiSessionSpan))

/**
 * Fixture spans through the wire schema, as the page receives them: the builders leave `sessionId`
 * and the unset gen_ai fields `undefined`, which the read never carries.
 */
export const toWire = (
	spans: ReadonlyArray<AiSessionSpan>,
	sessionId: string,
): ReadonlyArray<AiSessionSpan> =>
	spans.flatMap((span) => Option.toArray(decodeSpan(JSON.stringify({ ...span, sessionId }))))

/**
 * The page's navigations land as the route change the shell would deliver: only the view and the
 * open span are search, so the popover, the cursor and the landing follow them as on the page.
 */
const followNavigation = (
	session: SessionModel,
	outMessage: PageOutMessage | undefined,
	timeZone: string,
): SessionStep => {
	if (outMessage?._tag !== "RequestedNavigation") return { session, commands: [] }
	return Option.match(Option.map(fromString(`http://lab${outMessage.url}`), urlToAppRoute), {
		onNone: () => ({ session, commands: [] }),
		onSome: (next) => {
			if (next._tag !== "AgentSession") return { session, commands: [] }
			const search = { ...session.search, view: next.search.view, span: next.search.span }
			const changed = sessionRouteChanged(
				session,
				{ sessionId: session.sessionId, search },
				contextOf(timeZone),
			)
			return { session: changed.model, commands: withoutReads(changed.commands) }
		},
	})
}

const withoutReads = (commands: SessionCommands | undefined): SessionCommands =>
	(commands ?? []).filter((command) => !READS.has(command.name))

/** The page's step, with its navigations folded back in and its reads dropped. */
export const stepSession = (
	session: SessionModel,
	message: SessionMessage,
	timeZone: string,
): SessionStep => {
	const next = sessionUpdate(session, message, contextOf(timeZone))
	const followed = followNavigation(next.model, next.outMessage, timeZone)
	return { session: followed.session, commands: [...withoutReads(next.commands), ...followed.commands] }
}

/** The spans as the session's only page (reopened first, so a swap lands under the same key). */
export const withSpans = (
	session: SessionModel,
	spans: ReadonlyArray<AiSessionSpan>,
	timeZone: string,
): SessionStep =>
	stepSession(
		{ ...session, firstPage: { ...session.firstPage, data: AsyncData.Loading() } },
		SessionMessage.CompletedFetchFirstPage({
			key: session.firstPage.key ?? "",
			result: Result.succeed({ data: spans, nextCursor: null }),
		}),
		timeZone,
	)

/** Entered on `view` with `spans` already in hand. */
export const enterSession = (
	sessionId: string,
	view: string | undefined,
	spans: ReadonlyArray<AiSessionSpan>,
	timeZone: string,
): SessionStep => {
	const entered = sessionInit({ sessionId, search: { view } }, contextOf(timeZone))
	const loaded = withSpans(entered.model, spans, timeZone)
	return { session: loaded.session, commands: [...withoutReads(entered.commands), ...loaded.commands] }
}

type SessionInputs = Readonly<{ timeZone: string }>

/** `SessionHeader` over the session in hand. */
export const sessionTitle = Submodel.defineView<SessionModel, SessionMessage, SessionInputs>(
	(session, inputs, h) => sessionHeader(h, session, sessionData(session).summary, inputs.timeZone),
)

/** `SessionViews` over the session in hand. */
export const sessionViews = Submodel.defineView<SessionModel, SessionMessage, SessionInputs>(
	(session, inputs, h) => views(h, session, sessionData(session), inputs.timeZone),
)
