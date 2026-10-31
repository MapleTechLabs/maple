import type { V2OnboardingChecklist, V2OnboardingChecklistStep } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as OnboardingChecklist from "../../shell/onboarding-checklist"
import * as OnboardingChecklistView from "../../shell/onboarding-checklist-view"
import { defineLabWithFlags } from "../define"

// `/lab/onboarding-checklist`: the top bar's credits pill with its one-time pointer, then the panel in
// each state, over fixtures. Nothing is claimed.

const HOUR = 3_600_000

const step = (
	id: V2OnboardingChecklistStep["id"],
	title: string,
	completed: boolean,
	optional = false,
): V2OnboardingChecklistStep => ({
	object: "onboarding_checklist_step",
	id,
	title,
	completed,
	href: "/lab/onboarding-checklist",
	optional,
})

const checklistOf = (
	status: V2OnboardingChecklist["status"],
	done: ReadonlyArray<boolean>,
	nowMs: number,
): V2OnboardingChecklist => {
	const steps = [
		step("send_telemetry", "Send your first telemetry", done[0] ?? false),
		step("connect_github", "Connect GitHub", done[1] ?? false),
		step("create_alert_rule", "Create an alert with a destination", done[2] ?? false),
		step("connect_mcp_agent", "Connect an MCP agent", done[3] ?? false),
		step("invite_teammate", "Invite a teammate", done[4] ?? false, true),
	]
	const required = steps.filter((entry) => !entry.optional)
	return {
		object: "onboarding_checklist",
		status,
		reward_amount_usd: 30,
		deadline_at: new Date(nowMs + 17 * HOUR + 42 * 60_000).toISOString(),
		claimed_at: status === "claimed" ? new Date(nowMs).toISOString() : null,
		completed_count: required.filter((entry) => entry.completed).length,
		total_count: required.length,
		steps,
	}
}

export const Model = Schema.Struct({ nowMs: Schema.Number })
export type Model = typeof Model.Type

/** The pill's own messages, dropped: the lab only draws its states. */
type Message = OnboardingChecklist.Message

const modelOf = (
	nowMs: number,
	checklist: V2OnboardingChecklist,
	isAdmin = true,
): OnboardingChecklist.Model => ({
	...OnboardingChecklist.init(),
	checklist,
	isAdmin,
	isSeen: false,
	nowMs,
})

const frame = (h: HtmlBuilder<Message>, label: string, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("flex flex-col gap-2")],
		[
			h.span([h.Class("text-xs text-muted-foreground")], [label]),
			h.div(
				[
					h.Class(
						"w-[22rem] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-popup",
					),
				],
				children,
			),
		],
	)

const panelOf = (h: HtmlBuilder<Message>, model: OnboardingChecklist.Model): ReadonlyArray<Html> =>
	model.checklist === null ? [] : OnboardingChecklistView.checklistPanel(h, model, model.checklist)

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const inProgress = modelOf(
		model.nowMs,
		checklistOf("in_progress", [true, true, false, false, false], model.nowMs),
	)
	const claimable = modelOf(
		model.nowMs,
		checklistOf("claimable", [true, true, true, true, false], model.nowMs),
	)
	const claimed = {
		...modelOf(model.nowMs, checklistOf("claimed", [true, true, true, true, true], model.nowMs)),
		isJustClaimed: true,
	}
	return h.div(
		[h.Class("flex min-h-dvh flex-col gap-10 bg-background p-10 text-foreground")],
		[
			h.div(
				[h.Class("flex justify-end pb-24")],
				[
					h.submodel({
						slotId: "lab-onboarding-checklist-pill",
						model: inProgress,
						view: OnboardingChecklistView.view,
						toParentMessage: (message) => message,
					}),
				],
			),
			h.div(
				[h.Class("flex flex-wrap items-start gap-8")],
				[
					frame(h, "In progress", panelOf(h, inProgress)),
					frame(h, "Every step done", panelOf(h, claimable)),
					frame(h, "Claimed", panelOf(h, claimed)),
				],
			),
		],
	)
}

export const lab = defineLabWithFlags("Onboarding checklist", {
	Model,
	Flags: Schema.Struct({ nowMs: Schema.Number }),
	flags: Effect.sync(() => ({ nowMs: Date.now() })),
	init: (flags) => ({ model: { nowMs: flags.nowMs } }),
	update: (model) => ({ model }),
	view,
})
