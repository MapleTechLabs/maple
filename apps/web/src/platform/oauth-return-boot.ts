import { Effect } from "effect"
import { browserStorage, captureOAuthReturn } from "./oauth-return-stash"

// Imported first by `entry.ts`, so an OAuth return's fragment (it carries an authorization code)
// leaves the URL before routing, telemetry's page view or session replay can read it.
Effect.runSync(
	captureOAuthReturn({
		hash: window.location.hash,
		now: Date.now(),
		storage: browserStorage,
		stripHash: () =>
			window.history.replaceState(
				window.history.state,
				"",
				`${window.location.pathname}${window.location.search}`,
			),
	}),
)
