import type { Exposure, Runtimes } from "../page/security/telemetry/model"

// Fixtures for the Security Center's Exposure and Runtimes tabs, for `/lab/security` and the page's
// scene tests. Built relative to `now` so relative times read the same.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SIX_HOURS = 6 * HOUR

const at = (nowMs: number, agoMs: number): string => new Date(nowMs - agoMs).toISOString()

export const SAMPLE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"

export const emptyExposureOf = (): Exposure => ({ signatures: [], exposed: [], sources: [], timeline: [] })

/** Scanner traffic over a week: one SPA answering `/.env`, one live actuator, WordPress noise. */
/** A single-page app that answers every probe path with its index page. */
export const catchAllExposureOf = (nowMs: number): Exposure => {
	const base = exposureOf(nowMs)
	const paths = ["/.env", "/.git/", "/actuator/env", "phpinfo"]
	return {
		...base,
		signatures: [
			...base.signatures,
			...paths.map((signature) => ({
				signature,
				service: "web-app",
				requests: 30,
				answered: 30,
				sources: 3,
				lastSeen: at(nowMs, 20 * MINUTE),
			})),
		],
		exposed: [
			...base.exposed,
			{
				service: "web-app",
				host: "app.example.com",
				path: "/.env",
				signature: "/.env",
				httpStatus: 200,
				requests: 30,
				lastSeen: at(nowMs, 20 * MINUTE),
				sampleTraceId: SAMPLE_TRACE_ID,
			},
		],
	}
}

export const exposureOf = (nowMs: number): Exposure => ({
	signatures: [
		{
			signature: "/.env",
			service: "api-gateway",
			requests: 412,
			answered: 0,
			sources: 9,
			lastSeen: at(nowMs, 12 * MINUTE),
		},
		{
			signature: "/.env",
			service: "marketing-site",
			requests: 120,
			answered: 120,
			sources: 4,
			lastSeen: at(nowMs, 2 * HOUR),
		},
		{
			signature: "/.git/",
			service: "api-gateway",
			requests: 96,
			answered: 0,
			sources: 5,
			lastSeen: at(nowMs, 3 * HOUR),
		},
		{
			signature: "/.aws/",
			service: "api-gateway",
			requests: 41,
			answered: 0,
			sources: 3,
			lastSeen: at(nowMs, 5 * HOUR),
		},
		{
			signature: "/id_rsa",
			service: "api-gateway",
			requests: 7,
			answered: 0,
			sources: 1,
			lastSeen: at(nowMs, DAY),
		},
		{
			signature: "/actuator/env",
			service: "payments",
			requests: 33,
			answered: 2,
			sources: 2,
			lastSeen: at(nowMs, 40 * MINUTE),
		},
		{
			signature: "../",
			service: "api-gateway",
			requests: 18,
			answered: 0,
			sources: 2,
			lastSeen: at(nowMs, 2 * DAY),
		},
		{
			signature: "/wp-login.php",
			service: "marketing-site",
			requests: 210,
			answered: 210,
			sources: 6,
			lastSeen: at(nowMs, 30 * MINUTE),
		},
		{
			signature: "/xmlrpc.php",
			service: "marketing-site",
			requests: 64,
			answered: 64,
			sources: 3,
			lastSeen: at(nowMs, 4 * HOUR),
		},
		{
			signature: "",
			service: "api-gateway",
			requests: 640,
			answered: 602,
			sources: 5,
			lastSeen: at(nowMs, 8 * MINUTE),
		},
	],
	exposed: [
		{
			service: "marketing-site",
			host: "www.acme.dev",
			path: "/.env",
			signature: "/.env",
			httpStatus: 200,
			requests: 120,
			lastSeen: at(nowMs, 2 * HOUR),
			sampleTraceId: SAMPLE_TRACE_ID,
		},
		{
			service: "payments",
			host: "pay.acme.dev",
			path: "/actuator/env",
			signature: "/actuator/env",
			httpStatus: 200,
			requests: 2,
			lastSeen: at(nowMs, 40 * MINUTE),
			sampleTraceId: "0af7651916cd43dd8448eb211c80319c",
		},
	],
	sources: [
		{
			clientAddress: "198.51.100.23",
			requests: 702,
			signatures: 1,
			scanner: "ZGrab",
			userAgent: "Mozilla/5.0 zgrab/0.x",
			lastSeen: at(nowMs, 8 * MINUTE),
		},
		{
			clientAddress: "203.0.113.77",
			requests: 318,
			signatures: 6,
			scanner: "",
			userAgent:
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			lastSeen: at(nowMs, 12 * MINUTE),
		},
		{
			clientAddress: "192.0.2.140",
			requests: 214,
			signatures: 3,
			scanner: "Nuclei",
			userAgent:
				"Mozilla/5.0 (compatible; Nuclei - Open-source project (github.com/projectdiscovery/nuclei))",
			lastSeen: at(nowMs, 30 * MINUTE),
		},
		{
			clientAddress: "198.51.100.9",
			requests: 120,
			signatures: 2,
			scanner: "Censys",
			userAgent: "Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)",
			lastSeen: at(nowMs, 2 * HOUR),
		},
		{
			clientAddress: "2001:db8::4f",
			requests: 61,
			signatures: 2,
			scanner: "",
			userAgent: "",
			lastSeen: at(nowMs, 2 * DAY),
		},
	],
	timeline: Array.from({ length: 28 }, (_, index) => index)
		.filter((index) => index % 3 !== 1)
		.map((index) => {
			const bucket = Math.floor(nowMs / SIX_HOURS) * SIX_HOURS - (27 - index) * SIX_HOURS
			return {
				bucket: new Date(bucket).toISOString(),
				requests: 20 + ((index * 37) % 90),
				answered: (index * 11) % 20,
			}
		}),
})

/** One row per posture (end of life, behind, no version, unknown cycle, no release data, Bun as Node.js, Bun, supported, untracked) and per advisory state. */
export const runtimesOf = (nowMs: number): Runtimes => ({
	runtimes: [
		{
			service: "edge-router",
			environment: "production",
			runtimeName: "workerd",
			runtimeVersion: "",
			executableName: "",
			sdkLanguage: "nodejs",
			sdkName: "@microlabs/otel-cf-workers",
			sdkVersion: "1.0.0",
			spans: 90_000,
			lastSeen: at(nowMs, 2 * MINUTE),
		},
		{
			service: "billing-worker",
			environment: "staging",
			runtimeName: "cpython",
			runtimeVersion: "3.12.7",
			executableName: "",
			sdkLanguage: "python",
			sdkName: "opentelemetry",
			sdkVersion: "1.27.0",
			spans: 12_000,
			lastSeen: at(nowMs, 5 * MINUTE),
		},
		{
			service: "payments",
			environment: "production",
			runtimeName: "nodejs",
			runtimeVersion: "v22.4.0",
			executableName: "node",
			sdkLanguage: "nodejs",
			sdkName: "opentelemetry",
			sdkVersion: "1.26.0",
			spans: 48_000,
			lastSeen: at(nowMs, MINUTE),
		},
		{
			service: "inventory",
			environment: "production",
			runtimeName: "go",
			runtimeVersion: "",
			executableName: "",
			sdkLanguage: "go",
			sdkName: "opentelemetry",
			sdkVersion: "1.31.0",
			spans: 31_000,
			lastSeen: at(nowMs, 3 * MINUTE),
		},
		{
			service: "checkout-api",
			environment: "production",
			runtimeName: "nodejs",
			runtimeVersion: "v16.20.2",
			executableName: "node",
			sdkLanguage: "nodejs",
			sdkName: "opentelemetry",
			sdkVersion: "1.18.1",
			spans: 64_000,
			lastSeen: at(nowMs, MINUTE),
		},
		{
			service: "ledger",
			environment: "production",
			runtimeName: "OpenJDK Runtime Environment",
			runtimeVersion: "21.0.2+13",
			executableName: "",
			sdkLanguage: "java",
			sdkName: "opentelemetry",
			sdkVersion: "1.42.1",
			spans: 22_000,
			lastSeen: at(nowMs, 4 * MINUTE),
		},
		{
			service: "search",
			environment: "production",
			runtimeName: "nodejs",
			runtimeVersion: "v23.0.0-nightly",
			executableName: "node",
			sdkLanguage: "nodejs",
			sdkName: "",
			sdkVersion: "",
			spans: 4_000,
			lastSeen: at(nowMs, 20 * MINUTE),
		},
		{
			service: "notifications",
			environment: "production",
			runtimeName: "cpython",
			runtimeVersion: "3.13.1",
			executableName: "",
			sdkLanguage: "python",
			sdkName: "opentelemetry",
			sdkVersion: "1.27.0",
			spans: 2_000,
			lastSeen: at(nowMs, 9 * MINUTE),
		},
		{
			service: "realtime",
			environment: "production",
			runtimeName: "nodejs",
			runtimeVersion: "v22.6.0",
			executableName: "bun",
			sdkLanguage: "nodejs",
			sdkName: "opentelemetry",
			sdkVersion: "1.26.0",
			spans: 8_000,
			lastSeen: at(nowMs, 6 * MINUTE),
		},
		{
			service: "scraper",
			environment: "production",
			runtimeName: "bun",
			runtimeVersion: "1.4.0",
			executableName: "bun",
			sdkLanguage: "nodejs",
			sdkName: "@maple-dev/effect-sdk",
			sdkVersion: "0.9.0",
			spans: 26_000,
			lastSeen: at(nowMs, 2 * MINUTE),
		},
		// Upgraded off the vulnerable Bun three hours ago: the old version is history, not a finding.
		{
			service: "crawler",
			environment: "production",
			runtimeName: "bun",
			runtimeVersion: "1.4.0",
			executableName: "bun",
			sdkLanguage: "nodejs",
			sdkName: "@maple-dev/effect-sdk",
			sdkVersion: "0.9.0",
			spans: 70_000,
			lastSeen: at(nowMs, 3 * HOUR),
		},
		{
			service: "crawler",
			environment: "production",
			runtimeName: "bun",
			runtimeVersion: "1.4.4",
			executableName: "bun",
			sdkLanguage: "nodejs",
			sdkName: "@maple-dev/effect-sdk",
			sdkVersion: "0.9.0",
			spans: 9_000,
			lastSeen: at(nowMs, 4 * MINUTE),
		},
	],
	// Java is absent: its release data could not be read.
	releases: {
		nodejs: [
			{ cycle: "22", isEol: false, eolFrom: "2027-04-30", latest: "22.11.0" },
			{ cycle: "20", isEol: true, eolFrom: "2026-04-30", latest: "20.18.0" },
			{ cycle: "16", isEol: true, eolFrom: "2023-09-11", latest: "16.20.2" },
		],
		python: [{ cycle: "3.12", isEol: false, eolFrom: "2028-10-31", latest: "3.12.7" }],
		go: [{ cycle: "1.23", isEol: false, eolFrom: null, latest: "1.23.2" }],
		bun: [{ cycle: "1.4", isEol: false, eolFrom: null, latest: "1.4.4" }],
	},
	// Java is absent here too: its advisory read failed. Node.js 23 has none known.
	advisories: {
		"nodejs@22.4.0": [
			{
				id: "CVE-2025-55130",
				url: "https://osv.dev/vulnerability/BIT-node-2025-55130",
				summary: "Permission model bypass through crafted relative symlink paths.",
				severity: "critical",
				fixedIn: "22.22.0",
				published: "2026-01-26T14:47:49.864Z",
			},
			{
				id: "CVE-2026-48617",
				url: "https://osv.dev/vulnerability/BIT-node-2026-48617",
				summary: "Malformed HTTP/2 HEADERS frame crashes the process.",
				severity: "high",
				fixedIn: "22.17.1",
				published: "2026-06-23T14:50:46.123Z",
			},
			{
				id: "CVE-2026-58040",
				url: "https://osv.dev/vulnerability/BIT-node-2026-58040",
				summary: null,
				severity: "medium",
				fixedIn: "22.19.0",
				published: "2026-08-17T05:52:29.274Z",
			},
		],
		"nodejs@16.20.2": [
			{
				id: "CVE-2024-27983",
				url: "https://osv.dev/vulnerability/BIT-node-2024-27983",
				summary: "HTTP/2 server crash from a race in nghttp2.",
				severity: "high",
				fixedIn: "18.20.1",
				published: "2024-04-04T00:00:00.000Z",
			},
			{
				id: "CVE-2025-59466",
				url: "https://osv.dev/vulnerability/BIT-node-2025-59466",
				summary: "Uncatchable stack overflow through async_hooks.",
				severity: "high",
				fixedIn: null,
				published: "2026-01-26T14:47:58.830Z",
			},
		],
		"python@3.12.7": [
			{
				id: "CVE-2025-0938",
				url: "https://osv.dev/vulnerability/BIT-python-2025-0938",
				summary: "urllib.parse accepts square brackets in domain names.",
				severity: "medium",
				fixedIn: "3.12.9",
				published: "2025-01-31T00:00:00.000Z",
			},
		],
		"nodejs@23.0.0": [],
		"bun@1.4.4": [],
		// Bun 1.4.0 against Bun's GitHub advisories.
		"bun@1.4.0": [
			{
				id: "CVE-2026-111497",
				url: "https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p",
				summary: "Bundled brotli decoder has an out-of-bounds write (CVE-2026-111497)",
				severity: "high",
				fixedIn: "1.4.4",
				published: "2026-10-23T09:31:05Z",
			},
			{
				id: "GHSA-26q8-h657-pf84",
				url: "https://github.com/oven-sh/bun/security/advisories/GHSA-26q8-h657-pf84",
				summary: "Bundled root certificates trust compromised eMudhra (emSign) intermediate CAs",
				severity: "high",
				fixedIn: "1.4.4",
				published: "2026-10-23T02:02:06Z",
			},
		],
	},
	// Past the request's read budget.
	advisoriesSkipped: ["python@3.13.1"],
})
