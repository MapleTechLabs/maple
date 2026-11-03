import { Layer } from "effect"
import { Headers, HttpMiddleware } from "effect/http"
import { VCS_SYNC_BATCH_PATH } from "../worker/vcs-sync-dispatch"

// OAuth callbacks whose query string carries a provider-issued authorization
// `code` (exchangeable for an access token) plus the single-use connect `state`.
// `HttpMiddleware.tracer` stamps `url.full` and `url.query` verbatim on the
// server span — it redacts URL userinfo only, and `Headers.CurrentRedactedNames`
// covers headers, not query parameters — so tracing these requests would retain
// a live bearer credential in telemetry. There is no per-attribute lever, so the
// auto server span is suppressed for them; each callback handler carries its own
// span with safe attributes instead (see `IntegrationsCallbackRouter.*` and
// `ChatOAuth.callback`). The second alternative must stay in sync with the chat
// connector callback paths in `routes/chat-integration.http.ts`.
// `/oauth/authorize` is deliberately NOT here: its query carries no bearer
// credential, and `/oauth/token` + `/oauth/revoke` are POSTs (secrets in the body).
const OAUTH_CALLBACK_PATH =
	/^(?:\/api\/integrations\/[^/]+\/callback|\/oauth\/chat\/[^/]+(?:\/identity)?\/callback)(?:\?|$)/

// The email unsubscribe link's `token` query is a signed, non-expiring credential
// for opting a subscriber out; `DigestService.unsubscribeByToken` owns the span.
const EMAIL_UNSUBSCRIBE_PATH = /^\/api\/email\/unsubscribe(?:\?|$)/

// An uptime heartbeat ping's path segment is the monitor's secret token.
const HEARTBEAT_PING_PATH = /^\/hb\//

// The `TracerDisabledWhen` filter and the header-redaction list — both
// references `HttpMiddleware.tracer` reads regardless of which Tracer is
// active. The Worker registers this layer with alchemy's `Telemetry.layer`, so
// the bridge builds it into every event next to the SDK exporters: its tracer
// runs outside the app graph, which is why the references cannot live there.
export const ApiObservabilityLive = Layer.mergeAll(
	Layer.succeed(
		HttpMiddleware.TracerDisabledWhen,
		(request: { url: string; method: string }) =>
			request.url === "/health" ||
			// A VCS sync batch: its spans are `maple-vcs-sync`'s, and a minute-long server span here
			// would skew this service's latency.
			request.url === VCS_SYNC_BATCH_PATH ||
			request.method === "OPTIONS" ||
			OAUTH_CALLBACK_PATH.test(request.url) ||
			EMAIL_UNSUBSCRIBE_PATH.test(request.url) ||
			HEARTBEAT_PING_PATH.test(request.url) ||
			/\.(png|ico|jpg|jpeg|gif|css|js|svg|webp|woff2?)(\?.*)?$/i.test(request.url),
	),
	// Spans record only the allowlisted headers (`MapleHttpTracingLive`), none of
	// these; the list still redacts them wherever a `Headers` value is rendered or
	// logged. Effect's defaults cover the usual credential headers; the provider
	// webhook signatures are ours to add (a GitHub webhook HMAC is replayable
	// alongside its body, and there is no reason to retain it).
	Layer.succeed(Headers.CurrentRedactedNames, [
		"authorization",
		"cookie",
		"set-cookie",
		"x-api-key",
		"x-hub-signature",
		"x-hub-signature-256",
		// Svix (Clerk / Autumn webhooks): replayable alongside its body within the tolerance window.
		"svix-signature",
		// RFC 9449 proofs: short-lived, but a captured one replays within its window.
		"dpop",
	]),
)
