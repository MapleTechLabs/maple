import { onUndecodableRow } from "@maple/web-data/collections/live-row"
import { isChunkLoadError } from "@maple/web-data/lib/chunk-reload"
import { Clock, Duration, Effect, Option, Queue, Result, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Command, Dom } from "foldkit"
import { Message } from "./message"

// Notice when the server serves a newer build than this tab runs.

/** The commit this bundle was built from; empty (dev builds) turns the probe off. */
export const BUILT_COMMIT: string = import.meta.env.VITE_COMMIT_SHA ?? ""

const POLL_INTERVAL = Duration.minutes(15)

const VersionFile = Schema.Struct({ commit: Schema.String })

/** The deployed commit from `/version.json`, uncached; any failure reports nothing. */
const deployedCommit: Effect.Effect<Option.Option<string>, never, HttpClient.HttpClient> = Effect.gen(
	function* () {
		const now = yield* Clock.currentTimeMillis
		const client = yield* HttpClient.HttpClient
		// The timestamp busts every cache.
		const response = yield* client.get(`/version.json?t=${now}`)
		const { commit } = yield* HttpClientResponse.schemaBodyJson(VersionFile)(response)
		return commit.length > 0 ? Option.some(commit) : Option.none()
	},
).pipe(Effect.orElseSucceed(() => Option.none()))

/** `fetchDeployedCommit`: a hidden tab reports nothing. */
export const CheckDeployedCommit = Command.define("CheckDeployedCommit", {
	messages: [Message.CheckedDeployedCommit],
	execute: Effect.gen(function* () {
		if (document.hidden) return Message.CheckedDeployedCommit({ maybeCommit: Option.none() })
		return Message.CheckedDeployedCommit({ maybeCommit: yield* deployedCommit })
	}),
})

/** The banner's Reload button. */
export const ReloadPage = Command.define("ReloadPage", {
	messages: [Message.CompletedReloadPage],
	execute: Effect.sync(() => {
		window.location.reload()
		return Message.CompletedReloadPage()
	}),
})

/** Every 15 minutes, and whenever the tab becomes visible again. */
export const versionChecks: Stream.Stream<Message> = Stream.merge(
	Stream.fromSchedule(Schedule.spaced(POLL_INTERVAL)).pipe(
		Stream.map(() => Message.ElapsedVersionPollInterval()),
	),
	Dom.streamFromEventFilterMap({
		target: () => document,
		type: "visibilitychange",
		filterMapEvent: () => (document.hidden ? Option.none() : Option.some(Message.BecameTabVisible())),
	}),
)

// Stale-build recovery: a failure that a superseded build explains (a removed chunk, a synced
// row with a value this build does not know) probes the deployed commit at once instead of
// waiting for the next poll, and reloads onto the new build.

export type StaleSignal = Readonly<{ trigger: "chunk_load" | "undecodable_row"; detail: string }>

const RELOAD_KEY = "maple:stale-build-reload"

class ReloadGuardUnavailableError extends Schema.TaggedError<ReloadGuardUnavailableError>()(
	"@maple/web/shell/ReloadGuardUnavailableError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/**
 * At most one automatic reload per deployed commit per tab session: if the reload does not
 * land on the new build (a cached index.html), the next signal shows the banner instead.
 */
export const claimReload = (storage: Pick<Storage, "getItem" | "setItem">, commit: string) =>
	Effect.try({
		try: () => {
			if (storage.getItem(RELOAD_KEY) === commit) return false
			storage.setItem(RELOAD_KEY, commit)
			return true
		},
		catch: (cause) =>
			new ReloadGuardUnavailableError({ message: "session storage is unavailable", cause }),
	}).pipe(
		// Storage blocked: without the guard a reload could loop, so leave it to the banner.
		Effect.orElseSucceed(() => false),
	)

/**
 * `None` when the server runs this build (the failure is something else). Otherwise the
 * `CheckedDeployedCommit` raises the banner, after one reload when it is safe: a missing chunk
 * has already broken the page, but an unreadable row has not, so it reloads only a hidden tab
 * and never throws away a visible tab's unsaved edits.
 */
export const probeStaleBuild = (
	signal: StaleSignal,
	storage: Pick<Storage, "getItem" | "setItem">,
	isTabHidden: Effect.Effect<boolean>,
	reload: Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		yield* Effect.logWarning("Stale-build signal").pipe(
			Effect.annotateLogs({ trigger: signal.trigger, detail: signal.detail }),
		)
		const deployed = yield* deployedCommit
		const isNewer = Option.exists(deployed, (commit) => commit !== BUILT_COMMIT)
		yield* Effect.annotateCurrentSpan({ "maple.stale_build.newer": isNewer })
		if (!isNewer) return Option.none()
		const mayReload = signal.trigger === "chunk_load" || (yield* isTabHidden)
		const isReloading =
			mayReload && Option.isSome(deployed) && (yield* claimReload(storage, deployed.value))
		yield* Effect.annotateCurrentSpan({ "maple.stale_build.reloading": isReloading })
		if (isReloading) yield* reload
		return Option.some(Message.CheckedDeployedCommit({ maybeCommit: deployed }))
	}).pipe(
		Effect.withSpan("StaleBuildProbe", {
			attributes: {
				"maple.stale_build.trigger": signal.trigger,
				"maple.stale_build.detail": signal.detail,
			},
		}),
	)

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : typeof error === "string" ? error : "unknown"

const staleSignals: Stream.Stream<StaleSignal> = Stream.mergeAll(
	[
		// Vite reports every failed dynamic import (and its CSS/dep preloads) here.
		Dom.streamFromEventFilterMap({
			target: () => window,
			type: "vite:preloadError",
			filterMapEvent: (event) =>
				Option.some<StaleSignal>({ trigger: "chunk_load", detail: errorMessage(event.payload) }),
		}),
		Dom.streamFromEventFilterMap({
			target: () => window,
			type: "unhandledrejection",
			filterMapEvent: (event) =>
				isChunkLoadError(event.reason)
					? Option.some<StaleSignal>({ trigger: "chunk_load", detail: errorMessage(event.reason) })
					: Option.none(),
		}),
		Stream.callback<StaleSignal>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() =>
					onUndecodableRow((row) => {
						Queue.offerUnsafe(queue, {
							trigger: "undecodable_row",
							detail: `${row.collection} ${row.rowId}: ${row.message}`,
						})
					}),
				),
				(unsubscribe) => Effect.sync(unsubscribe),
			),
		),
	],
	{ concurrency: "unbounded" },
)

const reloadPage = Effect.sync(() => window.location.reload())
const isDocumentHidden = Effect.sync(() => document.hidden)

/** Probes on a stale-build signal; a burst (many bad rows at once) probes once. */
export const staleBuildRecovery: Stream.Stream<Message, never, HttpClient.HttpClient> = staleSignals.pipe(
	Stream.debounce(Duration.seconds(1)),
	Stream.mapEffect((signal) => probeStaleBuild(signal, sessionStorage, isDocumentHidden, reloadPage)),
	Stream.filterMap((message) => Result.fromOption(message, () => undefined)),
)
