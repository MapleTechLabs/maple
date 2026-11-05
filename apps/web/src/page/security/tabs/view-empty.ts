import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "@maple/views/ui/button"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { activeRepositoriesOf } from "./derive"
import { canManage, Message, type Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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
			action: typography(h, { size: "xs", tone: "muted" }, [
				"Runs stop at the org's monthly spend limit and report tokens and cost",
			]),
		}),
		h.ul(
			// Steps wrap onto more rows as the column narrows, like the run's phase strip.
			[h.Class("flex flex-wrap gap-px bg-border")],
			Arr.map(STEPS, (step) =>
				h.li(
					[h.Key(step.title), h.Class("flex min-w-44 flex-1 flex-col gap-1.5 bg-card px-4 py-4")],
					[
						typography(h, { size: "sm", weight: "medium" }, [step.title]),
						typography(h, { size: "xs", tone: "muted" }, [step.body]),
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
				hstack(h, { gap: "2", justify: "center", wrap: true }, [
					isConnected
						? canManage(model)
							? button(h, { attributes: [h.OnClick(Message.ClickedAddTarget())] }, [
									icon(h, "PlusIcon"),
									"Add target",
								])
							: typography(h, { size: "sm", tone: "muted" }, [
									"An org admin can add the first target.",
								])
						: linkButton(h, { href: integrations }, [icon(h, "GithubIcon"), "Connect GitHub"]),
				]),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					"Read-only access to the repositories you pick. Target code is never executed.",
				]),
			]),
		],
		emptyFrameClass("dashed"),
	)
}
