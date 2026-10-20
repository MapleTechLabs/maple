import { VERDICT_LAB_CASES } from "../verdict-fixture"
import { Clock, Effect, Schema } from "effect"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { verdictCard } from "../../page/investigations/detail/view-verdict"
import { defineShellLab } from "../shell-lab"

// `/lab/verdict`: the verdict card and run-progress feed in every
// state an investigation presents them in, inside the real shell.

const Model = Schema.Struct({ nowMs: Schema.Number })

export const lab = defineShellLab("Verdict", {
	Model,
	Message: Schema.Never,
	Flags: Model,
	/** `useTickingNow`'s first reading. */
	flags: Effect.map(Clock.currentTimeMillis, (nowMs) => ({ nowMs })),
	init: (flags) => ({ model: flags }),
	update: (model) => ({ model }),
	view: (model, h) =>
		dashboardPage(h, {}, [
			h.div(
				[h.Class("flex flex-col gap-10 py-2")],
				VERDICT_LAB_CASES.map((entry) =>
					h.section(
						[h.Key(entry.key), h.Class("flex flex-col gap-3")],
						[
							h.header(
								[h.Class("flex flex-col gap-1")],
								[
									h.h2([h.Class("text-sm font-semibold text-foreground")], [entry.title]),
									h.p(
										[h.Class("max-w-3xl text-xs leading-5 text-muted-foreground")],
										[entry.note],
									),
								],
							),
							verdictCard(h, entry.investigation, model.nowMs),
						],
					),
				),
			),
		]),
	currentPath: "/lab/verdict",
	breadcrumbs: [{ label: "Verdict Lab" }],
})
