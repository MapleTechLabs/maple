import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
import { activeRepositoriesOf } from "./derive"
import { Message, type Model } from "./model"

// No target yet: the on-ramp. Without a GitHub installation it points at GitHub; with one, at Add target.

type H = HtmlBuilder<Message>

const STEPS = [
	{ title: "Recon", body: "Maps entry points, trust boundaries and subsystems into a coverage ledger." },
	{ title: "Hunting waves", body: "One agent per unit. A critic adds missed units after each wave." },
	{ title: "Validation", body: "A different model tries to disprove each candidate finding." },
	{ title: "Verification", body: "Every surviving record is re-read and re-checked by a fresh verifier." },
	{ title: "Report", body: "Findings with evidence, exploit reasoning and fix guidance." },
] as const

export const auditSteps = (h: H): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "What one audit run does",
			action: h.span(
				[h.Class("text-xs text-muted-foreground")],
				["Runs stop at the org's monthly spend limit and report tokens and cost"],
			),
		}),
		h.ul(
			// Steps wrap onto more rows as the column narrows, like the run's phase strip.
			[h.Class("flex flex-wrap gap-px bg-border")],
			STEPS.map((step) =>
				h.li(
					[h.Key(step.title), h.Class("flex min-w-44 flex-1 flex-col gap-1.5 bg-card px-4 py-4")],
					[
						h.span([h.Class("text-sm font-medium")], [step.title]),
						h.span([h.Class("text-xs text-muted-foreground")], [step.body]),
					],
				),
			),
		),
	])

export const emptyOnRamp = (h: H, model: Model): Html => {
	const isConnected = activeRepositoriesOf(model).length > 0
	const integrations = hrefOf(AppRoute.Integrations({ search: {} }))
	return empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GithubIcon")]),
				emptyTitle(h, [isConnected ? "Add a repository to audit" : "Connect a repository to audit"]),
				emptyDescription(h, [
					"Maple maps the code into coverage units, audits each one, and has a second model try to disprove every finding before you see it.",
				]),
			]),
			emptyContent(h, [
				h.div(
					[h.Class("flex flex-wrap items-center justify-center gap-2")],
					[
						isConnected
							? model.isAdmin
								? button(h, { attributes: [h.OnClick(Message.ClickedAddTarget())] }, [
										icon(h, "PlusIcon"),
										"Add target",
									])
								: h.span(
										[h.Class("text-sm text-muted-foreground")],
										["An org admin can add the first target."],
									)
							: linkButton(h, { href: integrations }, [
									icon(h, "GithubIcon"),
									"Connect GitHub",
								]),
					],
				),
				h.p(
					[h.Class("text-xs text-muted-foreground")],
					["Read-only access to the repositories you pick. Target code is never executed."],
				),
			]),
		],
		"rounded-md border border-dashed md:py-14",
	)
}
