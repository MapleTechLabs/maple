import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Browser, chromium, type Page, type Route } from "playwright"
import {
	CANONICAL_ORIGIN,
	type AuthMode,
	fixtureBackendOrigin,
	fixtureElectricOrigin,
	outDir,
} from "./config.ts"
import {
	CAPTURE_HEADER,
	type CallLogEntry,
	DATASET_HEADER,
	type DatasetSummary,
	type FixtureBackend,
} from "./contract.ts"
import { clerkIdentityFor, installClerkStub } from "./runtime/clerk-stub.ts"
import { installSelfHostedSession, installTheme, selfHostedTokenFor } from "./runtime/session.ts"
import { BOX_STYLE_PROPS, collectSnapshot, serializeDom, TEXT_STYLE_PROPS } from "./runtime/snapshot.ts"
import { installDeterminism, waitForVisualQuiet } from "./runtime/stabilize.ts"
import {
	NO_DATASET_NOW,
	type Scenario,
	scenarios,
	type ThemeName,
	type ViewportName,
	viewports,
} from "./scenarios.ts"
import { buildExists, loadBuild, resolveStatic, type StaticBuild } from "./serve.ts"

/**
 * One capture = one (scenario, viewport, theme) rendered by one build.
 * Output per capture: `<id>.png`, `<id>.json` (structure, calls, ARIA) and `<id>.html` (reference DOM).
 */
export interface CaptureVariant {
	readonly scenario: Scenario
	readonly viewport: ViewportName
	readonly theme: ThemeName
	readonly id: string
}

export interface CaptureResult {
	readonly variantId: string
	readonly ok: boolean
	readonly error?: string
	readonly consoleErrors: ReadonlyArray<string>
	readonly blockedRequests: ReadonlyArray<string>
	/** Requests no fixture handler answered; any one fails the variant unless `nullBackend`. */
	readonly unmocked: ReadonlyArray<string>
	/** Captured without `src/backend`: unmocked calls are expected and only reported. */
	readonly nullBackend: boolean
	/** `window.Clerk` members the app read that the stub does not define (Clerk datasets only). */
	readonly clerkUnknown: ReadonlyArray<string>
	readonly durationMs: number
}

/** The snapshot file a capture writes per variant, read back by `compare.ts`. */
export interface CaptureFile {
	readonly url: string
	readonly calls: ReadonlyArray<CallLogEntry>
	readonly aria: string
}

/** `--filter` matches an area exactly or a variant id as a substring. */
export const expandVariants = (filter?: string): CaptureVariant[] =>
	scenarios
		.flatMap((scenario) =>
			(scenario.viewports ?? ["desktop"]).flatMap((viewport) =>
				(scenario.themes ?? ["light"]).map((theme) => ({
					scenario,
					viewport,
					theme,
					id: `${scenario.id}--${viewport}--${theme}`,
				})),
			),
		)
		.filter((variant) => filterMatches(filter, variant))

/** `--filter a,b`: a variant matches when its id contains, or its area equals, any of the terms. */
const filterMatches = (filter: string | undefined, variant: CaptureVariant) =>
	!filter ||
	filter
		.split(",")
		.map((term) => term.trim())
		.filter((term) => term !== "")
		.some((term) => variant.id.includes(term) || variant.scenario.area === term)

export const captureDir = (run: string, label: string) => join(outDir, "runs", run, label)

const SEED = 0x4a2e1

/**
 * Pages are served via `route.fulfill` (canonical origin), which Chromium treats as a public
 * address; its Local Network Access checks would then block calls to the loopback fixture backend.
 */
export const BROWSER_LAUNCH_OPTIONS = {
	args: [
		"--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
	],
}

/**
 * Console noise that does not indicate a broken capture: resource 404s (unmocked calls are tracked
 * on their own), requests the harness itself blocked (listed in `blockedRequests`), and Chrome's
 * notice that rrweb's replay iframe (`sandbox="allow-same-origin"`, no scripts by design) refused one.
 */
const IGNORED_CONSOLE_ERRORS =
	/Failed to load resource: the server responded with a status of 404|ERR_BLOCKED_BY_CLIENT|^Blocked script execution in '[^']*' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/

/** With a null backend every Electric shape 404s, and the app logs each collection it preloads. */
const NULL_BACKEND_CONSOLE_ERRORS =
	/^\[Live Query Error\] Source collection '[\w:-]+' entered error state|^An error occurred while syncing collection/

/**
 * Settles the page, starting over if a client-side redirect (`navigate({ replace: true })` on mount)
 * swaps the document mid-wait.
 */
/** Tallest viewport a full-page capture grows to, so a 10k-row list cannot make a 1 GB PNG. */
const MAX_FULL_PAGE_HEIGHT = 12_000

/**
 * App pages scroll an inner container (`h-screen` layouts), which `fullPage` cannot see. Grow the
 * viewport until no page-sized scroller overflows, so content below the fold is compared too.
 */
const growToContent = async (page: Page, settleAfter: () => Promise<void>) => {
	for (let round = 0; round < 4; round++) {
		const size = page.viewportSize()
		if (size === null) return
		const overflow = await page.evaluate((viewportHeight) => {
			let most = 0
			for (const element of document.querySelectorAll<HTMLElement>("*")) {
				const overflowY = getComputedStyle(element).overflowY
				if (overflowY !== "auto" && overflowY !== "scroll") continue
				if (element.clientHeight < viewportHeight / 2) continue
				most = Math.max(most, element.scrollHeight - element.clientHeight)
			}
			return most
		}, size.height)
		if (overflow <= 1 || size.height >= MAX_FULL_PAGE_HEIGHT) return
		await page.setViewportSize({
			width: size.width,
			height: Math.min(size.height + overflow, MAX_FULL_PAGE_HEIGHT),
		})
		await settleAfter()
	}
}

const settle = async (page: Page, options: { quietMs: number; timeoutMs: number }) => {
	for (let attempt = 0; ; attempt++) {
		const outcome = await page.evaluate(waitForVisualQuiet, options).then(
			() => "settled" as const,
			(cause: unknown) => cause,
		)
		if (outcome === "settled") return
		if (attempt >= 3 || !/Execution context was destroyed/.test(errorMessage(outcome))) throw outcome
		await page.waitForLoadState("load")
	}
}

/**
 * Screenshots until two in a row are byte-identical. Compositor-only motion (the overscroll bounce
 * after a wheel scroll hits an edge) is invisible to the in-page settle checks but not to pixels.
 */
const stableScreenshot = async (take: () => Promise<Buffer>) => {
	let previous = await take()
	for (let attempt = 0; attempt < 10; attempt++) {
		const next = await take()
		if (next.equals(previous)) return next
		previous = next
	}
	return previous
}

const fixtureOrigins = new Set([fixtureBackendOrigin, fixtureElectricOrigin])
/** Third-party stylesheets answered with an empty sheet instead of aborted (still listed as blocked). */
const EMPTY_STYLESHEET_HOSTS = new Set(["fonts.googleapis.com"])

interface RouteContext {
	readonly build: StaticBuild
	readonly backend: FixtureBackend | null
	readonly dataset: DatasetSummary | undefined
	readonly captureKey: string
	readonly blocked: string[]
	readonly localUnmocked: string[]
}

/** Canonical origin from the build directory, fixture origins tagged (or 404 without a backend), the rest aborted. */
const handleRoute = (context: RouteContext) => async (route: Route) => {
	const request = route.request()
	const url = new URL(request.url())
	if (url.origin === CANONICAL_ORIGIN) {
		const resolved = resolveStatic(context.build, url.pathname)
		if (resolved.kind === "file") return route.fulfill({ path: resolved.path })
		if (resolved.kind === "html")
			return route.fulfill({
				status: 200,
				contentType: "text/html; charset=utf-8",
				body: resolved.body,
			})
		return route.fulfill({ status: 404, body: "" })
	}
	if (!fixtureOrigins.has(url.origin)) {
		context.blocked.push(`${url.origin}${url.pathname}`)
		// A failed CSS `@import` is a failed preload, which `main.tsx` answers with a reload loop.
		if (EMPTY_STYLESHEET_HOSTS.has(url.hostname))
			return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: "" })
		return route.abort("blockedbyclient")
	}
	if (context.backend === null) {
		// CORS preflights are answered so the real request (and its 404) is what gets recorded.
		if (request.method() === "OPTIONS")
			return route.fulfill({
				status: 204,
				headers: {
					"access-control-allow-origin": CANONICAL_ORIGIN,
					"access-control-allow-credentials": "true",
					"access-control-allow-headers":
						request.headers()["access-control-request-headers"] ?? "*",
					"access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
				},
			})
		context.localUnmocked.push(
			`${request.method()} ${url.origin === fixtureElectricOrigin ? "electric:" : ""}${url.pathname}`,
		)
		return route.fulfill({
			status: 404,
			headers: {
				"access-control-allow-origin": CANONICAL_ORIGIN,
				"access-control-allow-credentials": "true",
			},
			body: "",
		})
	}
	return route.continue({
		headers: {
			...request.headers(),
			...datasetHeader(context.dataset),
			[CAPTURE_HEADER]: context.captureKey,
		},
	})
}

const datasetHeader = (dataset: DatasetSummary | undefined): Record<string, string> =>
	dataset === undefined ? {} : { [DATASET_HEADER]: dataset.name }

const installSession = async (
	page: Page,
	theme: ThemeName,
	authMode: AuthMode,
	dataset: DatasetSummary | undefined,
) => {
	await page.addInitScript(installDeterminism, SEED)
	await page.addInitScript(installTheme, theme)
	if (authMode === "clerk")
		await page.addInitScript(installClerkStub, dataset ? clerkIdentityFor(dataset) : null)
	else await page.addInitScript(installSelfHostedSession, dataset ? selfHostedTokenFor(dataset) : null)
}

const readClerkUnknown = (page: Page) =>
	page
		.evaluate(() => {
			const accesses = window.__parityClerkUnknown
			return accesses === undefined ? [] : [...accesses]
		})
		.catch(() => [])

const errorMessage = (cause: unknown) =>
	cause instanceof Error ? (cause.message.split("\n")[0] ?? "") : String(cause)

export interface CaptureOptions {
	/** Build name under `.parity/builds/` (a target, or a custom `--out`). */
	readonly build: string
	/** Output folder name under the run; defaults to the build name (self-checks capture one build twice). */
	readonly label?: string
	readonly run: string
	readonly variants: ReadonlyArray<CaptureVariant>
	readonly backend: FixtureBackend | null
	readonly browser?: Browser
}

const failedResult = (variantId: string, error: string): CaptureResult => ({
	variantId,
	ok: false,
	error,
	consoleErrors: [],
	blockedRequests: [],
	unmocked: [],
	nullBackend: false,
	clerkUnknown: [],
	durationMs: 0,
})

const captureVariant = async (
	browser: Browser,
	options: CaptureOptions,
	dir: string,
	variant: CaptureVariant,
) => {
	const started = performance.now()
	const label = options.label ?? options.build
	const datasetName = variant.scenario.dataset
	const dataset = datasetName
		? options.backend?.datasets.find((entry) => entry.name === datasetName)
		: undefined
	if (datasetName && !dataset)
		return failedResult(
			variant.id,
			options.backend
				? `unknown dataset "${datasetName}"`
				: `dataset "${datasetName}" needs the fixture backend (src/backend)`,
		)
	const authMode: AuthMode = dataset?.auth ?? "self_hosted"
	if (!buildExists(options.build, authMode))
		return failedResult(
			variant.id,
			`no ${authMode} build "${options.build}" (bun run parity build <target> --auth ${authMode})`,
		)
	const build = loadBuild(options.build, authMode)
	const captureKey = `${label}/${variant.id}`
	const context = await browser.newContext({
		viewport: viewports[variant.viewport],
		deviceScaleFactor: 1,
		colorScheme: variant.theme,
		reducedMotion: "reduce",
		timezoneId: "UTC",
		locale: "en-US",
		serviceWorkers: "block",
	})
	const page = await context.newPage()
	page.setDefaultTimeout(5000)
	const consoleErrors: string[] = []
	const blocked: string[] = []
	const localUnmocked: string[] = []
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300))
	})
	page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message.slice(0, 300)}`))
	await page.clock.setFixedTime(dataset?.now ?? NO_DATASET_NOW)
	await installSession(page, variant.theme, authMode, dataset)
	await page.route(
		"**/*",
		handleRoute({ build, backend: options.backend, dataset, captureKey, blocked, localUnmocked }),
	)

	let clerkUnknown: ReadonlyArray<string> = []
	const backendUnmocked: string[] = []
	const capture = async () => {
		await page.goto(`${CANONICAL_ORIGIN}${variant.scenario.path}`, { waitUntil: "load" })
		await settle(page, { quietMs: 400, timeoutMs: 8000 })
		if (variant.scenario.steps) {
			await variant.scenario.steps(page)
			await settle(page, { quietMs: 300, timeoutMs: 5000 })
		}
		if (variant.scenario.fullPage ?? true)
			await growToContent(page, () => settle(page, { quietMs: 300, timeoutMs: 5000 }))
		const screenshot = await stableScreenshot(() =>
			page.screenshot({
				fullPage: variant.scenario.fullPage ?? true,
				mask: variant.scenario.mask ? [...variant.scenario.mask(page)] : undefined,
				animations: "disabled",
				caret: "hide",
			}),
		)
		writeFileSync(join(dir, `${variant.id}.png`), screenshot)
		const snapshot = await page.evaluate(collectSnapshot, {
			textProps: [...TEXT_STYLE_PROPS],
			boxProps: [...BOX_STYLE_PROPS],
		})
		// Behavior and accessibility as of the screenshot: calls sent so far and the ARIA tree.
		const taken = options.backend?.takeCalls(captureKey)
		backendUnmocked.push(...(taken?.unmocked ?? []))
		const calls = taken?.calls ?? []
		const aria = await page.locator("body").ariaSnapshot()
		const file: CaptureFile = { url: page.url(), calls, aria }
		writeFileSync(join(dir, `${variant.id}.json`), JSON.stringify({ ...snapshot, ...file }))
		writeFileSync(join(dir, `${variant.id}.html`), await page.evaluate(serializeDom))
		if (authMode === "clerk") clerkUnknown = await readClerkUnknown(page)
	}
	// A failed step still leaves a screenshot of where it stopped.
	const error = await capture().then(
		() => undefined,
		async (cause: unknown) => {
			await page.screenshot({ path: join(dir, `${variant.id}.png`) }).catch(() => undefined)
			return errorMessage(cause)
		},
	)
	await context.close()
	// Late calls (after the screenshot) and the backend's own unmocked list, then forgotten.
	const unmocked = [
		...localUnmocked,
		...backendUnmocked,
		...(options.backend?.takeCalls(captureKey).unmocked ?? []),
	]

	const result: CaptureResult = {
		variantId: variant.id,
		ok: error === undefined,
		error,
		consoleErrors: consoleErrors.filter(
			(line) =>
				!IGNORED_CONSOLE_ERRORS.test(line) &&
				!(options.backend === null && NULL_BACKEND_CONSOLE_ERRORS.test(line)),
		),
		blockedRequests: [...new Set(blocked)],
		unmocked: [...new Set(unmocked)],
		nullBackend: options.backend === null,
		clerkUnknown,
		durationMs: Math.round(performance.now() - started),
	}
	return result
}

export const captureTarget = async (options: CaptureOptions): Promise<CaptureResult[]> => {
	const label = options.label ?? options.build
	const dir = captureDir(options.run, label)
	mkdirSync(dir, { recursive: true })
	const browser = options.browser ?? (await chromium.launch(BROWSER_LAUNCH_OPTIONS))
	const results: CaptureResult[] = []
	for (const variant of options.variants) {
		const result = await captureVariant(browser, options, dir, variant)
		results.push(result)
		const status = !result.ok
			? `FAILED: ${result.error}`
			: result.unmocked.length
				? `ok, ${result.unmocked.length} unmocked`
				: "ok"
		console.log(`[capture] ${label} ${variant.id} ${status} (${result.durationMs}ms)`)
	}
	writeFileSync(join(dir, "_results.json"), JSON.stringify(results, null, 2))
	if (!options.browser) await browser.close()
	return results
}
