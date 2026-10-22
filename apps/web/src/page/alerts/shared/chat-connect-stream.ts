import { ChatConnectorId } from "@maple/domain/primitives"
import { Effect, Queue, Schema, Stream } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { Message, type Model } from "./chat-connect"

// The popup itself (`useOAuthPopupFlow`): opened in the click, sent to the install URL, ticked
// every 500 ms (a poll every sixth tick), and closed when the Subscription releases it.

const WINDOW_NAME = "maple-chat-connect"
const WINDOW_FEATURES = "popup,width=640,height=760"
const POPUP_TICK_MS = 500
const POLL_EVERY_TICKS = 6
/** Slack's consent page can sever the opener: polling continues this long after a close. */
const CLOSE_GRACE_MS = 5 * 60_000

/** A Subscription's dependencies: one attempt in one phase. */
export const Dependencies = Schema.Struct({
	attempt: Schema.NullOr(Schema.Number),
	connector: Schema.NullOr(ChatConnectorId),
	name: Schema.String,
	phase: Schema.Literals(["popup", "grace", "idle"]),
})
export type Dependencies = typeof Dependencies.Type

export const dependenciesOf = (model: Model, isEnabled = true): Dependencies =>
	model.active === null || !isEnabled
		? { attempt: null, connector: null, name: "", phase: "idle" }
		: {
				attempt: model.active.attempt,
				connector: model.active.connector,
				name: model.active.name,
				phase: model.active.phase,
			}

const interimDocument = (label: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Connecting to ${label}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:13px;
    background:#fff; color:#3f3f46; }
  @media (prefers-color-scheme: dark) { body { background:#1c1917; color:#d6d3d1; } }
</style></head><body>Connecting to ${label}…</body></html>`

const install = (connector: ChatConnectorId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.chatIntegration.install({ params: { connector } })
		return response.url
	}).pipe(Effect.mapError((error) => toLoadFailure(error).message))

/** Ticks while `isClosed` is false (or for `graceMs` once closed): `Polled`, then `ClosedPopup`. */
const tick = (
	attempt: number,
	offer: (message: Message) => void,
	isClosed: () => boolean,
	graceMs: number | null,
) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const state = { ticks: 0 }
			const interval = window.setInterval(() => {
				state.ticks += 1
				if (state.ticks % POLL_EVERY_TICKS === 0) offer(Message.Polled({ attempt }))
				if (graceMs === null && isClosed()) {
					window.clearInterval(interval)
					offer(Message.ClosedPopup({ attempt }))
				}
			}, POPUP_TICK_MS)
			const timeout =
				graceMs === null
					? undefined
					: window.setTimeout(() => offer(Message.EndedGrace({ attempt })), graceMs)
			return { interval, timeout }
		}),
		({ interval, timeout }) =>
			Effect.sync(() => {
				window.clearInterval(interval)
				if (timeout !== undefined) window.clearTimeout(timeout)
			}),
	)

const closing = (popup: Window | null) => Effect.addFinalizer(() => Effect.sync(() => popup?.close()))

/** `connect`: open in the click, install, then send the popup to the platform and watch it. */
const popupFlow = (attempt: number, connector: ChatConnectorId, name: string) =>
	Stream.callback<Message, never, MapleApiV2Client>((queue) =>
		Effect.gen(function* () {
			const offer = (message: Message) => {
				Queue.offerUnsafe(queue, message)
			}
			const popup = yield* Effect.sync(() => {
				const opened = window.open("", WINDOW_NAME, WINDOW_FEATURES)
				if (opened !== null) {
					opened.document.write(interimDocument(name))
					opened.document.close()
				}
				return opened
			})
			yield* closing(popup)
			const started = yield* Effect.result(install(connector))
			if (started._tag === "Failure") {
				offer(Message.FailedStart({ attempt, description: started.failure }))
				return yield* Effect.never
			}
			const url = started.success
			const target = yield* Effect.sync(() => {
				if (popup !== null && !popup.closed) {
					popup.location.href = url
					return popup
				}
				// The gesture is long gone: this only works when the first window was closed, not blocked.
				return window.open(url, WINDOW_NAME, WINDOW_FEATURES)
			})
			yield* closing(target)
			if (target === null) {
				offer(Message.BlockedPopup({ attempt }))
				return yield* Effect.never
			}
			offer(Message.SucceededStart({ attempt }))
			yield* tick(attempt, offer, () => target.closed, null)
			return yield* Effect.never
		}),
	)

/** After a close, the grace keeps polling; then the attempt ends. */
const grace = (attempt: number) =>
	Stream.callback<Message>((queue) =>
		tick(
			attempt,
			(message) => Queue.offerUnsafe(queue, message),
			() => true,
			CLOSE_GRACE_MS,
		).pipe(Effect.andThen(Effect.never)),
	)

export const streamOf = ({
	attempt,
	connector,
	name,
	phase,
}: Dependencies): Stream.Stream<Message, never, MapleApiV2Client> =>
	attempt === null || connector === null || phase === "idle"
		? Stream.empty
		: phase === "popup"
			? popupFlow(attempt, connector, name)
			: grace(attempt)
