import { Clock, Duration, Effect, Option, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Dom } from "foldkit"
import { ShellDefinition } from "./definition"
import { Message } from "./message"

// Notice when the server serves a newer build than this tab runs.

/** The commit this bundle was built from; empty (dev builds) turns the probe off. */
export const BUILT_COMMIT: string = import.meta.env.VITE_COMMIT_SHA ?? ""

const POLL_INTERVAL = Duration.minutes(15)

const VersionFile = Schema.Struct({ commit: Schema.String })

/** `fetchDeployedCommit`: `/version.json`, uncached; a hidden tab or any failure reports nothing. */
export const CheckDeployedCommit = ShellDefinition.makeCommand("CheckDeployedCommit", {
	messages: [Message.CheckedDeployedCommit],
	handler: function* () {
		return () =>
			Effect.gen(function* () {
				if (document.hidden) return Message.CheckedDeployedCommit({ maybeCommit: Option.none() })
				const now = yield* Clock.currentTimeMillis
				const client = yield* HttpClient.HttpClient
				// The timestamp busts every cache.
				const response = yield* client.get(`/version.json?t=${now}`)
				const { commit } = yield* HttpClientResponse.schemaBodyJson(VersionFile)(response)
				return Message.CheckedDeployedCommit({
					maybeCommit: commit.length > 0 ? Option.some(commit) : Option.none(),
				})
			}).pipe(Effect.orElseSucceed(() => Message.CheckedDeployedCommit({ maybeCommit: Option.none() })))
	},
})

/** The banner's Reload button. */
export const ReloadPage = ShellDefinition.makeCommand("ReloadPage", {
	messages: [Message.CompletedReloadPage],
	handler: function* () {
		return () =>
			Effect.sync(() => {
				window.location.reload()
				return Message.CompletedReloadPage()
			})
	},
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
