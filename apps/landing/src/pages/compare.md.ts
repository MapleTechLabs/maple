/**
 * `/compare.md`: the comparison hub, serialized: one line per page, then the
 * line-item bill for every vendor on one sheet.
 */
import type { APIRoute } from "astro"
import { BILL_ROW_KEYS, billRowLabels, billVendors } from "../lib/bill-comparison"
import { alternativesPages, alternativesPath } from "../lib/alternatives"
import { competitors } from "../lib/competitors"
import { absolute, blocks, docHeader, markdown, table } from "../lib/page-markdown"
import * as m from "../paraglide/messages.js"
import { Array as Arr } from "effect"

export const GET: APIRoute = ({ site }) => {
	const pages = blocks(
		`## ${m.cmp_hub_pages_title()}`,
		Arr.join(
			Arr.map(
				competitors,
				(c) =>
					`- [${c.navLabel()}](${absolute(site, `/compare/${c.slug}.md`)}): ${c.navDesc()} (HTML: ${absolute(site, `/compare/${c.slug}`)})`,
			),
			"\n",
		),
	)

	const roundups = blocks(
		"## Alternatives roundups",
		Arr.join(
			Arr.map(
				alternativesPages,
				(page) =>
					`- [${page.vendor} alternatives](${absolute(site, `${alternativesPath(page.slug)}.md`)}): ${page.blurb} (HTML: ${absolute(site, alternativesPath(page.slug))})`,
			),
			"\n",
		),
	)

	// The same cells BillComparison.astro prints, from the same module.
	const vendors = billVendors()
	const labels = billRowLabels()
	const bill = blocks(
		`## ${m.cmp_hub_matrix_title()}`,
		m.bill_lede(),
		table(
			[m.bill_col_metric(), ...Arr.map(vendors, (vendor) => vendor.name)],
			Arr.map(BILL_ROW_KEYS, (key) => [
				labels[key],
				...Arr.map(vendors, (vendor) => vendor.cells[key]),
			]),
		),
		m.bill_footnote(),
	)

	return markdown(blocks(docHeader(m.cmp_hub_title(), m.cmp_hub_lede()), pages, roundups, bill))
}
