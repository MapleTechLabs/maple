import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { ChatApiGroup } from "./chat"
import { V1SchemaErrors, V1UnexpectedErrors } from "./v1-boundary"

/**
 * What the AI Worker serves over HTTP.
 *
 * Separate from `MapleInternalApi` for one mechanical reason and one real one.
 * The mechanical one: an `HttpApi` must have every declared group implemented by
 * whoever builds it, so a group cannot straddle two Workers. The real one: this
 * is now a different deployable with its own release cadence, and a contract
 * that says so is easier to reason about than one that silently expects two
 * scripts to stay in step.
 *
 * The paths are unchanged — `apps/api` forwards `/internal/chat/*` here over a
 * service binding — so this is a change of which Worker answers, not of what the
 * dashboard calls. The error envelope stays v1's for the same reason
 * `MapleInternalApi` keeps it: `apps/web` already decodes it.
 *
 * The chat SSE routes are deliberately NOT here. They are a raw `HttpRouter`,
 * because `HttpApi` cannot model an open `text/event-stream`.
 */
export class MapleAiApi extends HttpApi.make("MapleAiApi")
	.add(ChatApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Maple AI API",
			version: "1.0.0",
			description:
				"Private dashboard transport for the agent surfaces. Not public API, not documented, not stable — do not build against it.",
		}),
	) {}
