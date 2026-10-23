import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
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
				["Each run has an invocation budget and reports tokens and cost"],
			),
		}),
		h.ol(
			[h.Class("grid divide-y md:grid-cols-5 md:divide-x md:divide-y-0")],
			STEPS.map((step, index) =>
				h.li(
					[h.Key(step.title), h.Class("flex flex-col gap-1.5 px-4 py-4")],
					[
						h.span(
							[h.Class("font-mono text-xs text-muted-foreground tabular-nums")],
							[String(index + 1).padStart(2, "0")],
						),
						h.span([h.Class("text-sm font-medium")], [step.title]),
						h.span([h.Class("text-xs text-muted-foreground")], [step.body]),
					],
				),
			),
		),
	])

export const emptyOnRamp = (h: H, model: Model): Html => {
	const isConnected = Option.match(AsyncData.getData(model.githubStatus.data), {
		onNone: () => false,
		onSome: (status) => status.connected && status.repositories.some((repo) => repo.status === "active"),
	})
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
		"rounded-md border md:py-16",
	)
}
