import { LAB_ENTRIES, type LabEntry as RegistryEntry } from "../registry"
import type { Html, HtmlBuilder } from "foldkit/html"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { eyebrow } from "../../ui/eyebrow"
import { defineStaticShellLab } from "../static-shell-lab"

// `/lab`: every lab and bench surface, read from the registry.

const SECTIONS: ReadonlyArray<{ kind: RegistryEntry["kind"]; title: string; blurb: string }> = [
	{
		kind: "lab",
		title: "Labs",
		blurb: "Component galleries over fixture data. Open one, change the component, watch it re-render.",
	},
	{
		kind: "bench",
		title: "Benches",
		blurb: "Synthetic perf harnesses. Open them in a foreground tab when measuring by hand.",
	},
]

const entryCard = <M>(h: HtmlBuilder<M>, entry: RegistryEntry): Html =>
	h.li(
		[],
		[
			h.a(
				[
					h.Href(entry.path),
					h.Class(
						"flex h-full flex-col gap-1 rounded-md border bg-card px-3 py-2.5 transition-colors hover:bg-accent",
					),
				],
				[
					h.span(
						[h.Class("flex items-baseline justify-between gap-2")],
						[
							h.span([h.Class("text-sm font-medium")], [entry.title]),
							h.span([h.Class("font-mono text-2xs text-muted-foreground")], [entry.path]),
						],
					),
					h.span([h.Class("text-xs text-muted-foreground")], [entry.description]),
					...(entry.session === "required"
						? [
								h.span(
									[
										h.Class(
											"mt-1 self-start rounded-sm border px-1.5 py-0.5 text-3xs uppercase tracking-wide text-muted-foreground",
										),
									],
									["Session required"],
								),
							]
						: []),
				],
			),
		],
	)

const page = <M>(h: HtmlBuilder<M>): Html =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("flex flex-col")],
			[
				h.div(
					[h.Class("border-b px-4 py-3")],
					[
						h.h1([h.Class("text-sm font-semibold")], ["Lab"]),
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Dev-only surfaces. Everything here is a 404 in production and stays out of the startup bundle.",
							],
						),
					],
				),
				...SECTIONS.map((section) =>
					h.section(
						[h.Key(section.kind), h.Class("border-b px-4 py-4")],
						[
							eyebrow(h, { variant: "label", as: "h2" }, [section.title]),
							h.p([h.Class("mt-1 text-xs text-muted-foreground")], [section.blurb]),
							h.ul(
								[h.Class("mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3")],
								LAB_ENTRIES.filter((entry) => entry.kind === section.kind).map((entry) =>
									entryCard(h, entry),
								),
							),
						],
					),
				),
			],
		),
	])

export const lab = defineStaticShellLab("Lab", { currentPath: "/lab", breadcrumbs: [{ label: "Lab" }], page })
