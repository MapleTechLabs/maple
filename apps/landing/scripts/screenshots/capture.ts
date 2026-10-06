#!/usr/bin/env bun
/**
 * `bun run screenshots`: capture the landing site's app screenshots from the
 * local stack. Seed it first with `bun run seed:demo` at the repo root; the
 * time ranges come from that run's anchor.
 *
 * Signs in with a one-shot Clerk ticket (dev instances only, like
 * `bun run dev:signin`), renders at 2x, and writes webp via `cwebp`.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { chromium, type BrowserContext, type Page } from "playwright"
import { RELABEL, SHOTS, TIMEZONE, VIEWPORT, type Shot } from "./shots"

const ROOT = new URL("../../../../", import.meta.url).pathname
const SEED_STATE = `${ROOT}scripts/seed-demo/.last-seed.json`
const OUT_DIR = new URL("../../public/screenshots/", import.meta.url).pathname
const DEV_EMAIL = "david+clerk_test@gmail.com"
const MINUTE = 60_000

class CaptureError extends Schema.TaggedError<CaptureError>()("@maple/landing/CaptureError", {
	message: Schema.String,
	shot: Schema.optional(Schema.String),
}) {}

const SeedState = Schema.Struct({ anchor: Schema.DateTimeUtcFromString, orgId: Schema.NullOr(Schema.String) })

const pw = <A>(message: string, run: () => Promise<A>, shot?: string) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new CaptureError({
				message: `${message}: ${String(cause)}`,
				shot,
			}),
	})

// ── sign-in ─────────────────────────────────────────────────────────────────

const ClerkUsers = Schema.Array(Schema.Struct({ id: Schema.String }))
const ClerkTicket = Schema.Struct({ token: Schema.String })

const mintTicket = Effect.fn("capture.mintTicket")(
	function* (email: string) {
		const secret = process.env.CLERK_SECRET_KEY ?? ""
		if (!secret.startsWith("sk_test_")) {
			return yield* new CaptureError({
				message: "CLERK_SECRET_KEY must be a development key (sk_test_…)",
			})
		}
		const client = (yield* HttpClient.HttpClient).pipe(
			HttpClient.mapRequest(HttpClientRequest.bearerToken(secret)),
			HttpClient.filterStatusOk,
		)
		const users = yield* client
			.get(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`)
			.pipe(
				Effect.flatMap((response) => response.json),
				Effect.flatMap(Schema.decodeUnknownEffect(ClerkUsers)),
			)
		const user = users[0]
		if (!user) return yield* new CaptureError({ message: `no Clerk user ${email}` })
		const ticket = yield* client
			.execute(
				HttpClientRequest.post("https://api.clerk.com/v1/sign_in_tokens").pipe(
					HttpClientRequest.bodyText(
						JSON.stringify({ user_id: user.id, expires_in_seconds: 600 }),
						"application/json",
					),
				),
			)
			.pipe(
				Effect.flatMap((response) => response.json),
				Effect.flatMap(Schema.decodeUnknownEffect(ClerkTicket)),
			)
		return ticket.token
	},
	Effect.mapError((cause) => new CaptureError({ message: `Clerk sign-in ticket: ${cause.message}` })),
)

// ── page prep ───────────────────────────────────────────────────────────────

const FREEZE_CSS = `
*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }
[data-sonner-toaster], #react-scan-root, .tsqd-parent-container { display: none !important; }
`

const relabel = (page: Page) =>
	pw("relabel", () =>
		page.evaluate((pairs) => {
			const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				for (const [from, to] of pairs) {
					if (node.nodeValue?.includes(from)) node.nodeValue = node.nodeValue.replaceAll(from, to)
				}
			}
		}, Object.entries(RELABEL)),
	)

/** Network quiet and no skeletons left: the page is showing data, not a loading state. */
const settle = (page: Page, shot: string) =>
	pw(
		"wait for data",
		async () => {
			await page.waitForLoadState("networkidle")
			await page.waitForFunction(
				() => document.querySelectorAll('[data-slot="skeleton"], .animate-pulse').length === 0,
				null,
				{
					timeout: 30_000,
				},
			)
			await page.waitForTimeout(400)
		},
		shot,
	)

const warehouseTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

const shotUrl = (base: string, shot: Shot, anchor: number) => {
	const url = new URL(shot.route, base)
	for (const [key, value] of Object.entries(shot.search ?? {})) {
		// TanStack Router reads non-string search values as JSON.
		url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value))
	}
	// Dev-only plan-gate bypass: the demo org never went through billing onboarding.
	url.searchParams.set("quota_preview", "1")
	if (shot.range) {
		url.searchParams.set("startTime", warehouseTime(anchor - shot.range.fromMinutes * MINUTE))
		url.searchParams.set("endTime", warehouseTime(anchor - shot.range.toMinutes * MINUTE))
	}
	return url.toString()
}

const capture = Effect.fn("capture.shot")(function* (
	context: BrowserContext,
	base: string,
	shot: Shot,
	anchor: number,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const fs = yield* FileSystem.FileSystem
	const page = yield* Effect.acquireRelease(
		pw("open page", () => context.newPage(), shot.id),
		(page) => Effect.promise(() => page.close()),
	)
	yield* pw("navigate", () => page.goto(shotUrl(base, shot, anchor)), shot.id)
	yield* pw("freeze", () => page.addStyleTag({ content: FREEZE_CSS }), shot.id)
	yield* settle(page, shot.id)
	const setup = shot.setup
	if (setup) {
		yield* pw("setup", () => setup(page), shot.id)
		yield* settle(page, shot.id)
	}
	yield* relabel(page)

	const png = yield* fs.makeTempFileScoped({ suffix: ".png" })
	yield* pw("screenshot", () => page.screenshot({ path: png }), shot.id)
	const out = `${OUT_DIR}${shot.id}.webp`
	yield* spawner
		.string(ChildProcess.make("cwebp", ["-quiet", "-q", "90", png, "-o", out]))
		.pipe(
			Effect.mapError(
				(cause) => new CaptureError({ message: `cwebp: ${cause.message}`, shot: shot.id }),
			),
		)
	yield* Console.log(`  ✓ ${shot.id}  ${out.replace(ROOT, "")}`)
}, Effect.scoped)

// ── command ─────────────────────────────────────────────────────────────────

const command = Command.make(
	"capture-screenshots",
	{
		only: Flag.String("only").pipe(Flag.withDescription("Comma-separated shot ids"), Flag.optional),
		web: Flag.String("web").pipe(
			Flag.withDescription("Local web origin"),
			Flag.withDefault(process.env.MAPLE_DEV_WEB_URL ?? "https://web.localhost"),
		),
		email: Flag.String("email").pipe(Flag.withDescription("Dev Clerk user"), Flag.withDefault(DEV_EMAIL)),
		list: Flag.Boolean("list").pipe(
			Flag.withDescription("Print each shot's URL and exit"),
			Flag.withDefault(false),
		),
	},
	Effect.fn("capture")(function* (flags) {
		const fs = yield* FileSystem.FileSystem
		const state = yield* fs.readFileString(SEED_STATE).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SeedState))),
			Effect.mapError(
				() =>
					new CaptureError({
						message: `no seed state at ${SEED_STATE}. Run \`bun run seed:demo\` first.`,
					}),
			),
		)
		const anchor = DateTime.toEpochMillis(state.anchor)
		const wanted = Option.map(flags.only, (only) => new Set(only.split(",").map((id) => id.trim())))
		const shots = SHOTS.filter((shot) =>
			Option.match(wanted, { onNone: () => true, onSome: (ids) => ids.has(shot.id) }),
		)
		if (shots.length === 0) return yield* new CaptureError({ message: "no shots match --only" })

		if (flags.list) {
			for (const shot of shots) yield* Console.log(`${shot.id}\n  ${shotUrl(flags.web, shot, anchor)}`)
			return
		}

		yield* Console.log(
			`capturing ${shots.length} shot(s) at anchor ${DateTime.formatIso(state.anchor)} (org ${state.orgId ?? "unknown"})`,
		)
		const ticket = yield* mintTicket(flags.email)
		const browser = yield* Effect.acquireRelease(
			pw("launch Chrome", () => chromium.launch({ channel: "chrome" })),
			(browser) => Effect.promise(() => browser.close()),
		)
		const context = yield* pw("new context", () =>
			browser.newContext({
				viewport: VIEWPORT,
				deviceScaleFactor: 2,
				timezoneId: TIMEZONE,
				colorScheme: "dark",
				reducedMotion: "reduce",
				ignoreHTTPSErrors: true,
			}),
		)
		const signIn = yield* pw("open sign-in", () => context.newPage())
		yield* pw("sign in", async () => {
			await signIn.goto(`${flags.web}/sign-in?__clerk_ticket=${encodeURIComponent(ticket)}`)
			await signIn.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 })
			await signIn.close()
		})

		yield* Effect.forEach(shots, (shot) => capture(context, flags.web, shot, anchor), { discard: true })
	}, Effect.scoped),
).pipe(Command.withDescription("Capture landing screenshots from the seeded local stack"))

Command.run(command, { version: "1.0.0" }).pipe(
	Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
	NodeRuntime.runMain,
)
