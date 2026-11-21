/**
 * Renders the status card for every theme preset and status into a folder, through the same
 * renderer the Worker uses, for eyeballing a change and for PR screenshots:
 *
 *   bun run --cwd apps/status og:samples [out-dir]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { initSync } from "@takumi-rs/wasm"
import {
	STATUS_PAGE_PRESET_DEFAULTS,
	type StatusPageFreshness,
	type StatusPageThemeAppearance,
	type StatusPageThemePreset,
} from "@maple/domain/status-page"
import { statusOgCard } from "@maple/status-page"
import { FIXTURE_NOW, makeComponent, makeDays, makeIncident, makeSnapshot } from "@maple/status-page/fixtures"
import { inlineLogo } from "../src/og-logo"
import { makeOgRenderer } from "../src/og-render"

const out = process.argv[2] ?? "og-samples"
mkdirSync(out, { recursive: true })

const fontsDir = join(import.meta.dirname, "../src/og-fonts")
const subsets = (font: string) => ({
	latin: readFileSync(join(fontsDir, `${font}-latin.ttf`)),
	"latin-ext": readFileSync(join(fontsDir, `${font}-latin-ext.ttf`)),
	cyrillic: readFileSync(join(fontsDir, `${font}-cyrillic.ttf`)),
})
const NO_LOGO = { _tag: "none" } as const
const render = await makeOgRenderer(
	async () => {
		initSync({
			module: readFileSync(
				join(import.meta.dirname, "../node_modules/@takumi-rs/wasm/pkg/takumi_wasm_bg.wasm"),
			),
		})
	},
	{
		sans: subsets("sans"),
		serif: subsets("serif"),
		mono: subsets("mono"),
	},
)

const live: StatusPageFreshness = { _tag: "live", updatedAt: FIXTURE_NOW }

const components = {
	operational: [
		makeComponent(0, { name: "API", days: makeDays(FIXTURE_NOW, { 40: "degraded", 71: "down" }) }),
		makeComponent(1, { name: "Dashboard" }),
		makeComponent(2, { name: "Webhooks" }),
	],
	degraded: [
		makeComponent(0, {
			name: "API",
			status: "degraded",
			days: makeDays(FIXTURE_NOW, { 89: "degraded" }),
		}),
		makeComponent(1, { name: "Dashboard" }),
	],
	major: [
		makeComponent(0, {
			name: "API",
			status: "major_outage",
			days: makeDays(FIXTURE_NOW, { 89: "down" }),
		}),
		makeComponent(1, { name: "Dashboard", status: "partial_outage" }),
		makeComponent(2, { name: "Webhooks", status: "degraded" }),
	],
} as const

const SCENARIOS = {
	operational: { components: components.operational, incidents: [] },
	degraded: { components: components.degraded, incidents: [] },
	incident: {
		components: components.major,
		incidents: [
			makeIncident("a", { title: "Elevated API error rates in us-east", impact: "critical" }),
			makeIncident("b", { title: "Webhook deliveries delayed" }),
		],
	},
} as const

const variants: ReadonlyArray<{
	readonly preset: StatusPageThemePreset
	readonly appearance: StatusPageThemeAppearance
	readonly accent?: string
}> = [
	{ preset: "default", appearance: "auto" },
	{ preset: "default", appearance: "dark" },
	{ preset: "maple", appearance: "dark" },
	{ preset: "mono", appearance: "light" },
	{ preset: "midnight", appearance: "dark", accent: "#a78bfa" },
	{ preset: "paper", appearance: "light" },
]

for (const variant of variants) {
	for (const [scenario, fields] of Object.entries(SCENARIOS)) {
		const snapshot = makeSnapshot({
			page: {
				...makeSnapshot().page,
				name: "Acme Cloud",
				theme: {
					preset: variant.preset,
					appearance: variant.appearance,
					accent: variant.accent ?? null,
					background: null,
					text: null,
					card: null,
					border: null,
					...STATUS_PAGE_PRESET_DEFAULTS[variant.preset],
				},
			},
			components: [...fields.components],
			incidents: [...fields.incidents],
		})
		const card = statusOgCard(snapshot, live, "status.acme.dev")
		const file = join(out, `${variant.preset}-${variant.appearance}-${scenario}.png`)
		writeFileSync(file, await render(card, NO_LOGO))
		console.log(file)
	}
}

const delayed = statusOgCard(
	makeSnapshot({ components: [...components.operational] }),
	{ _tag: "delayed", updatedAt: FIXTURE_NOW - 3_600_000 },
	"status.acme.dev",
)
writeFileSync(join(out, "default-delayed.png"), await render(delayed, NO_LOGO))

// Worst cases: long text everywhere, scripts beyond basic Latin, an uploaded logo.
const long =
	"Elevated error rates and timeouts on the public API, the dashboard and webhook deliveries across every region"
const worst = statusOgCard(
	makeSnapshot({
		page: {
			...makeSnapshot().page,
			name: `Acme Cloud Platform Infrastructure Services International ${long}`,
		},
		components: [makeComponent(0, { name: "API", status: "major_outage" })],
		incidents: [
			makeIncident("a", { title: long }),
			makeIncident("b", { title: "Łódź region: płatności opóźnione" }),
			makeIncident("c", { title: "Сбой платежей в регионе Москва" }),
		],
	}),
	live,
	"a-very-long-custom-status-domain-name-for-the-company.status.example-enterprise.com",
)
writeFileSync(join(out, "worst-long-text.png"), await render(worst, NO_LOGO))
const intl = statusOgCard(
	makeSnapshot({
		page: { ...makeSnapshot().page, name: "Żabka Płatności" },
		components: [makeComponent(0, { name: "Платежи", status: "degraded" })],
	}),
	live,
	"status.zabka.pl",
)
writeFileSync(join(out, "worst-intl.png"), await render(intl, NO_LOGO))
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 48"><rect width="48" height="48" rx="10" fill="#2563eb"/><text x="60" y="34" font-size="30" font-family="sans-serif" fill="#111">Acme</text></svg>`
const uploaded = statusOgCard(
	makeSnapshot({ page: { ...makeSnapshot().page, logoUrl: `data:image/svg+xml;base64,${btoa(svg)}` } }),
	live,
	"status.acme.dev",
)
writeFileSync(join(out, "uploaded-logo.png"), await render(uploaded, inlineLogo(uploaded.logoUrl ?? "")))
