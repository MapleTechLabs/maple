import { MapleFoldkit } from "@maple-dev/effect-sdk/foldkit"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { selfIngestUrl } from "../lib/services/common/ingest-url"
import { Option } from "effect"
import { fromString } from "foldkit/url"
import { urlToAppRoute } from "../route"

/** `navigate ServiceDetail`, not one span name per service, trace or dashboard id. */
const routeName = (pathname: string): string =>
	Option.match(fromString(`https://maple.invalid${pathname}`), {
		onNone: () => pathname,
		onSome: (url) => urlToAppRoute(url)._tag,
	})

/**
 * The app's own telemetry: service, ingest, anticipated errors, replay and privacy switches.
 * `maple.web.app` names the frontend that sent it.
 */
const maple = MapleFoldkit.make({
	serviceName: "maple-web",
	endpoint: selfIngestUrl,
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
	// The stage's name (`production`, `pr-<n>`, `development`); a preview build's MODE is `production` too.
	environment: import.meta.env.VITE_MAPLE_ENVIRONMENT || import.meta.env.MODE,
	serviceVersion: import.meta.env.VITE_COMMIT_SHA,
	attributes: {
		"service.namespace": "core",
		"maple.web.app": "foldkit",
		"vcs.repository.url.full": "https://github.com/MapleTechLabs/maple",
		...(import.meta.env.VITE_COMMIT_SHA
			? { "vcs.ref.head.revision": import.meta.env.VITE_COMMIT_SHA }
			: undefined),
	},
	anticipatedErrorIdentifiers: [
		...ANTICIPATED_ERROR_IDENTIFIERS,
		"@maple/web/errors/WarehouseUnreachableError",
	],
	routeName,
	// Starts no child span, but it is the boot's longest step before the first data read.
	keepCommands: ["LoadClerk"],
	// One frame: a view or patch over 16ms drops a frame, which the SDK's 50ms default does not report.
	slowPhases: { View: 16, Patch: 16 },
	// The perf bench builds with VITE_MAPLE_REPLAY=off and VITE_MAPLE_CAPTURE=off.
	replay: {
		enabled: import.meta.env.VITE_MAPLE_REPLAY !== "off",
		// Dashboard charts draw to <canvas>, which replays leave blank without this.
		canvasFps: 1,
	},
	privacy: {
		...(import.meta.env.VITE_MAPLE_COOKIE_DOMAIN
			? { cookieDomain: import.meta.env.VITE_MAPLE_COOKIE_DOMAIN }
			: undefined),
		...(import.meta.env.VITE_MAPLE_CAPTURE === "off" ? { requireConsent: true } : undefined),
	},
})

export const instrument = maple.instrument
