import { BillingCustomer } from "@maple/domain/http"
import { Array as Arr, Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { billingBanners } from "../../shell/billing-banners"
import { Message } from "../../shell/message"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { vstack } from "@maple/views/ui/stack"
import { defineLab } from "../define"

// `/lab/trial-banners`: every no-card trial banner over fixtures, one under the other: a signal
// at its cap, the trial's last days, a cap coming up, and the trial ended.

const DAY = 86_400_000
const NOW_MS = Date.UTC(2026, 10, 25, 12)

const Model = Schema.Struct({})
type Model = typeof Model.Type

const balance = (usage: number) => ({ granted: 100, usage, remaining: Math.max(0, 100 - usage) })

const onTrial = (daysLeft: number, usage: { logs: number; traces: number; metrics: number }) =>
	Schema.decodeSync(BillingCustomer)({
		id: "org_lab",
		subscriptions: [{ planId: "trial", status: "active", trialEndsAt: NOW_MS + daysLeft * DAY }],
		balances: {
			logs: balance(usage.logs),
			traces: balance(usage.traces),
			metrics: balance(usage.metrics),
		},
	})

const STATES: ReadonlyArray<readonly [string, BillingCustomer]> = [
	["Logs and metrics at their cap", onTrial(9, { logs: 100, traces: 40, metrics: 100 })],
	["Last days", onTrial(2, { logs: 30, traces: 12, metrics: 5 })],
	["Traces nearing the cap", onTrial(9, { logs: 30, traces: 86, metrics: 5 })],
	[
		// As Autumn returns it: the ended trial's row deleted, the trial kept in `trialsUsed`.
		"Trial ended",
		Schema.decodeSync(BillingCustomer)({
			id: "org_lab",
			subscriptions: [],
			trialsUsed: [{ planId: "trial" }],
		}),
	],
]

const view = (_: Model, h: HtmlBuilder<Message>): Html =>
	vstack(
		h,
		{ gap: "6", className: "mx-auto w-full max-w-4xl py-6" },
		Arr.map(STATES, ([label, customer]) =>
			vstack(h, { gap: "1" }, [
				eyebrow(h, { className: "px-4", as: "div" }, [label]),
				...billingBanners(h, Option.some(customer), false, NOW_MS),
			]),
		),
	)

export const lab = defineLab("Trial banners", {
	Model,
	init: () => ({ model: {} }),
	update: (model: Model, _message: Message) => ({ model }),
	view,
})
