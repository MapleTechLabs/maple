/**
 * `/compare/<slug>.md`: the comparison registry, serialized.
 *
 * English-only and un-prefixed, like every other twin: an endpoint runs
 * outside Paraglide's per-render locale storage, so the thunks resolve to the
 * source locale, which is what we want.
 *
 * Same order as the HTML page (differences, price, migration, FAQ,
 * sources) and the same numbers: the receipts are priced with the functions
 * the page and the calculator use, so the three can't disagree.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import { competitors, type Competitor, MAPLE_SURFACES } from "../../lib/competitors"
import { absolute, blocks, docHeader, markdown, table } from "../../lib/page-markdown"
import * as m from "../../paraglide/messages.js"
import {
	defaultValues,
	describeWorkload,
	estimateMaple,
	estimateVendor,
	formatLineAmount,
	MAPLE_PRICING_NOTE,
	PRICES_VERIFIED,
	vendorCaveat,
	vendorConfigs,
} from "../../lib/vendor-pricing"
import { Array as Arr, String as Str } from "effect"

export const getStaticPaths: GetStaticPaths = () =>
	Arr.map(competitors, (competitor) => ({ params: { slug: competitor.slug }, props: { competitor } }))

const monthLabel = (checked: string) =>
	new Date(`${checked}-15T00:00:00Z`).toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	})

const dollars = (amount: number) => formatLineAmount(amount)

/** Pipes inside a cell would break the row. */
const cell = (text: string) => Str.replaceAll("|", "\\|")(Str.replaceAll("\\", "\\\\")(text))

export const GET: APIRoute = ({ props, site }) => {
	const { competitor } = props as { competitor: Competitor }
	const name = competitor.name

	const edgeLabel = (edge: Competitor["differences"][number]["edge"]) =>
		edge === "maple" ? "Maple" : edge === "competitor" ? name : m.cmp_diff_edge_even()

	const rowsFor = (edge: "differ" | "ahead") =>
		Arr.map(
			Arr.filter(competitor.differences, (row) =>
				edge === "ahead" ? row.edge === "competitor" : row.edge !== "competitor",
			),
			(row) => [
				cell(row.topic()),
				cell(row.maple()),
				cell(row.competitor()) + (row.source !== undefined ? ` [${row.source + 1}]` : ""),
				edgeLabel(row.edge),
			],
		)

	const differences = blocks(
		`## ${m.cmp_diff_title({ name })}`,
		m.cmp_diff_lede(),
		`### ${m.cmp_diff_group_differ()}`,
		table([m.cmp_diff_col_topic(), "Maple", name, m.cmp_diff_col_edge()], rowsFor("differ")),
		rowsFor("ahead").length > 0 ? `### ${m.cmp_diff_group_ahead({ name })}` : undefined,
		rowsFor("ahead").length > 0
			? table([m.cmp_diff_col_topic(), "Maple", name, m.cmp_diff_col_edge()], rowsFor("ahead"))
			: undefined,
		`**${m.cmp_parity_label()}:** ${Arr.join(
			Arr.map(competitor.parity, (item) => item()),
			" · ",
		)}`,
	)

	// The Surfaces section, where the page has one: the same four rows, with
	// the artifact's argument carried by its copy rather than the drawing.
	const surfaces = competitor.surfaces
		? blocks(
				`## ${m.cmp_surfaces_title({ name })}`,
				competitor.surfaces.lede(),
				Arr.join(
					Arr.map(competitor.surfaces.rows, (row) => {
						const surface = MAPLE_SURFACES[row.surface]
						return `- **${surface.name()}**: ${surface.body()} ${m.cmp_surfaces_instead_label({ name })} ${row.instead()}`
					}),
					"\n",
				),
			)
		: undefined

	const values = defaultValues(competitor.vendor)
	const config = vendorConfigs[competitor.vendor]
	const maple = estimateMaple(competitor.vendor, values)
	const theirs = estimateVendor(competitor.vendor, values)
	const delta = theirs.total - maple.total
	const receipt = (label: string, estimate: typeof maple) =>
		table(
			[label, "Amount"],
			[
				...Arr.map(estimate.breakdown, (item) => [
					`${item.label}: ${item.detail}`,
					item.value === 0 ? m.cmp_price_free() : dollars(item.value),
				]),
				["**Total**", `**${dollars(estimate.total)}**`],
			],
		)

	const price = blocks(
		`## ${m.cmp_price_title()}`,
		m.cmp_price_lede(),
		`**${m.cmp_price_workload()}:** ${describeWorkload(competitor.vendor, values)}`,
		receipt("Maple", maple),
		receipt(config.name, theirs),
		delta >= 0
			? m.cmp_price_less({ amount: dollars(delta) })
			: m.cmp_price_more({ amount: dollars(-delta) }),
		`${m.cmp_price_verified({ date: monthLabel(PRICES_VERIFIED) })} ${MAPLE_PRICING_NOTE} ${vendorCaveat[competitor.vendor]}`,
		`Interactive calculator: ${absolute(site, `/compare/${competitor.slug}#calculator`)}`,
	)

	const migration = blocks(
		`## ${m.cmp_migration_title({ name })}`,
		m.cmp_migration_lede(),
		Arr.join(
			Arr.map(competitor.migration, (step, i) => `${i + 1}. **${step.title()}** ${step.body()}`),
			"\n",
		),
		`\`\`\`yaml\n# otel-collector.yaml. ${m.cmp_migration_diff_caption()}\n${competitor.migrationDiff}\n\`\`\``,
	)

	const faq = blocks(
		`## ${m.faq_heading()}`,
		...Arr.map(competitor.faqs, (f) => `### ${f.question()}\n\n${f.answer()}`),
	)

	const sources = blocks(
		`## ${m.cmp_sources_title({ name })}`,
		m.cmp_sources_lede(),
		Arr.join(
			Arr.map(
				competitor.sources,
				(s, i) =>
					`${i + 1}. [${s.label}](${s.url}), ${m.cmp_sources_checked({ date: monthLabel(s.checked) })}`,
			),
			"\n",
		),
	)

	const related = blocks(
		`## ${m.cmp_related_title()}`,
		Arr.join(
			Arr.map(
				Arr.filter(competitors, (entry) => entry.slug !== competitor.slug),
				(entry) => `- [${entry.navLabel()}](${absolute(site, `/compare/${entry.slug}.md`)})`,
			),
			"\n",
		),
	)

	return markdown(
		blocks(
			docHeader(competitor.heroTitle(), competitor.heroLede()),
			differences,
			surfaces,
			price,
			migration,
			faq,
			sources,
			related,
		),
	)
}
