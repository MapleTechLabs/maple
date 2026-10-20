import type { V2PlanetScaleScrapeTarget } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import {
	type MetricsAuth,
	metricsHealthState,
	type SetupStep,
} from "../../components/integrations/planetscale-setup-steps"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { icon } from "../../ui/icon"
import { inlineCode } from "../../ui/inline-code"
import * as Field from "../../ui/field"
import { spinner } from "../../ui/spinner"
import { statusDot } from "../../ui/status-dot"
import { relativeTime } from "../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"
import { SECRET_PREFIX } from "./planetscale"

// `PlanetScaleMetricsHealth`, `PlanetScaleMetricsTokenForm`,
// `PlanetScaleSetupChecklist` and `PlanetScaleOrgPicker`.

type H = HtmlBuilder<Message>

export const QUIET_LINK =
	"text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground"

const HEADLINE = new Map([
	["degraded", "Metrics collection degraded"],
	["stalled", "Metrics collection stalled"],
	["waiting", "Waiting for first metrics"],
	["healthy", "Metrics"],
])

export const metricsHealth = (
	h: H,
	model: Model,
	target: V2PlanetScaleScrapeTarget,
	metricsAuth: MetricsAuth,
	timeZone: string,
	action: Html | null,
): Html => {
	const state = metricsHealthState(target, metricsAuth, model.nowMs)
	if (state === "unconfigured") return h.empty
	const isOpen = model.planetscaleCard.isDetailsOpen
	return h.div(
		[h.Class("border-t border-border/60 p-4")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2 text-xs")],
				[
					statusDot(h, {
						tone: state === "healthy" ? "ok" : state === "waiting" ? "neutral" : "warn",
					}),
					h.span([h.Class("font-medium text-foreground")], [HEADLINE.get(state) ?? ""]),
					h.span(
						[h.Class("text-muted-foreground")],
						[
							...(state === "waiting"
								? ["Branch metrics usually appear within a minute."]
								: target.last_scrape_at !== null
									? [
											relativeTime(h, {
												value: target.last_scrape_at,
												nowMs: model.nowMs,
												timeZone,
												prefix: state === "healthy" ? "Updated" : "Last data",
											}),
										]
									: []),
							...(state === "healthy" && target.exclude_branches.length > 0
								? [" · excluding ", target.exclude_branches.join(", ")]
								: []),
						],
					),
					...(state === "healthy"
						? [
								h.a(
									[
										h.Href(hrefOf(AppRoute.InfraPlanetscale({ search: {} }))),
										h.Class(QUIET_LINK),
									],
									["View databases"],
								),
							]
						: []),
					h.div(
						[h.Class("ml-auto flex items-center gap-2")],
						[
							...(state === "degraded"
								? [
										button(
											h,
											{
												variant: "link",
												size: "xs",
												className: `h-auto p-0 font-normal ${QUIET_LINK}`,
												attributes: [h.OnClick(Message.ClickedMetricsDetails())],
											},
											[isOpen ? "Hide details" : "Show details"],
										),
									]
								: []),
							...(action === null ? [] : [action]),
						],
					),
				],
			),
			...(state === "degraded" && isOpen
				? [
						h.p(
							[
								h.Class(
									"mt-2 break-all rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground",
								),
							],
							[target.last_scrape_error ?? ""],
						),
					]
				: []),
		],
	)
}

const tokenSettingsUrl = (organization: string) =>
	`https://app.planetscale.com/${encodeURIComponent(organization)}/settings/service-tokens`

const tokenInput = (
	h: H,
	model: Model,
	field: "id" | "secret",
	options: Readonly<{ id: string; label: string; placeholder: string; type?: "password" }>,
): Html => {
	const fieldModel = field === "id" ? model.planetscaleCard.tokenId : model.planetscaleCard.tokenSecret
	const state = Field.stateOf(fieldModel, false)
	const ids: Field.FieldIds = {
		control: options.id,
		label: `${options.id}-label`,
		error: `${options.id}-error`,
	}
	return Field.field(h, { className: "min-w-40 flex-1 items-stretch gap-1.5", state }, [
		Field.fieldLabel(h, { ids, state }, options.label),
		Field.input(h, {
			ids,
			state,
			attributes: [
				...(options.type === undefined ? [] : [h.Type(options.type)]),
				h.Placeholder(options.placeholder),
				h.Autocomplete("off"),
				...Field.controlAttributes(h, fieldModel, (message) =>
					Message.GotMetricsTokenMessage({ field, message }),
				),
				h.OnPastePreventDefault((text) => Option.some(Message.PastedMetricsToken({ field, text }))),
			],
		}),
	])
}

/** `PlanetScaleMetricsTokenForm`. */
export const metricsTokenForm = (
	h: H,
	model: Model,
	organization: string | null,
	docsUrl: string | undefined,
	mode: "initial" | "rotate",
	canCancel: boolean,
): Html => {
	const card = model.planetscaleCard
	const secret = card.tokenSecret.value
	const looksWrong = secret.length > 0 && !secret.startsWith(SECRET_PREFIX)
	const canSubmit = card.tokenId.value.trim().length > 0 && secret.length > 0
	const linkHref = organization !== null ? tokenSettingsUrl(organization) : (docsUrl ?? null)
	return h.div(
		[h.Class("flex flex-col gap-3")],
		[
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				[
					"Create a service token with the single ",
					inlineCode(h, {}, ["read_metrics_endpoints"]),
					" ",
					"permission — no other permission is needed, and Maple never uses it for anything else.",
				],
			),
			...(linkHref === null
				? []
				: [
						h.div(
							[],
							[
								linkButton(
									h,
									{
										size: "sm",
										variant: "outline",
										href: linkHref,
										attributes: [h.Target("_blank"), h.Rel("noreferrer")],
									},
									[
										organization !== null
											? "Create a token in PlanetScale"
											: "How to create a token",
										icon(h, "ExternalLinkIcon"),
									],
								),
							],
						),
					]),
			h.div(
				[h.Class("flex flex-wrap items-end gap-2")],
				[
					tokenInput(h, model, "id", {
						id: "ps-metrics-token-id",
						label: "Service token ID",
						placeholder: "tok_…",
					}),
					tokenInput(h, model, "secret", {
						id: "ps-metrics-token-secret",
						label: "Service token secret",
						placeholder: `${SECRET_PREFIX}…`,
						type: "password",
					}),
					h.div(
						[h.Class("flex items-center gap-1.5")],
						[
							...(canCancel
								? [
										button(
											h,
											{
												variant: "outline",
												isDisabled: card.isSavingToken,
												attributes: [h.OnClick(Message.ClickedRotateCancel())],
											},
											["Cancel"],
										),
									]
								: []),
							button(
								h,
								{
									isDisabled: !canSubmit,
									isLoading: card.isSavingToken,
									attributes: [h.OnClick(Message.SubmittedMetricsToken())],
								},
								[mode === "rotate" ? "Update token" : "Enable metrics"],
							),
						],
					),
				],
			),
			...(looksWrong && card.tokenError === null
				? [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"That doesn't look like a service token secret — it usually starts with",
								" ",
								inlineCode(h, {}, [SECRET_PREFIX]),
								".",
							],
						),
					]
				: []),
			...(card.tokenError === null
				? []
				: [h.p([h.Class("text-xs text-severity-error"), h.Role("alert")], [card.tokenError])]),
		],
	)
}

/** `StepMarker`: done, blocked, current (a spinner while Maple works), else the step number. */
const stepMarker = (h: H, step: SetupStep, number: number): Html => {
	if (step.state === "done")
		return icon(h, "CircleCheckIcon", {
			size: 14,
			className: "mt-0.5 shrink-0 text-severity-info",
			attributes: [h.AriaHidden(true)],
		})
	if (step.state === "blocked")
		return icon(h, "CircleWarningIcon", {
			size: 14,
			className: "mt-0.5 shrink-0 text-severity-error",
			attributes: [h.AriaHidden(true)],
		})
	if (step.state === "current")
		return step.waitingOnMaple
			? spinner(h, "mt-0.5 shrink-0 text-muted-foreground", 14)
			: h.span(
					[
						h.AriaHidden(true),
						h.Class(
							"mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full bg-primary text-4xs font-medium text-primary-foreground",
						),
					],
					[String(number)],
				)
	return h.span(
		[
			h.AriaHidden(true),
			h.Class(
				"mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border border-border text-4xs font-medium text-muted-foreground",
			),
		],
		[String(number)],
	)
}

/** `PlanetScaleSetupChecklist`: the active step carries its action. */
export const setupChecklist = (
	h: H,
	steps: ReadonlyArray<SetupStep>,
	actionOf: (id: SetupStep["id"]) => Html | null,
): Html =>
	h.ol(
		[h.Class("flex flex-col")],
		steps.map((step, index) => {
			const action = step.state === "current" || step.state === "blocked" ? actionOf(step.id) : null
			return h.li(
				[h.Class("flex gap-3 border-b border-border/60 py-2.5 last:border-b-0 last:pb-0 first:pt-0")],
				[
					stepMarker(h, step, index + 1),
					h.div(
						[h.Class("min-w-0 flex-1")],
						[
							h.div(
								[h.Class("flex flex-wrap items-baseline gap-x-2")],
								[
									h.span(
										[
											h.Class(
												cn(
													"text-xs font-medium",
													step.state === "pending"
														? "text-muted-foreground"
														: "text-foreground",
												),
											),
										],
										[step.title],
									),
									h.span(
										[
											h.Class(
												cn(
													"text-xs",
													step.state === "blocked"
														? "text-severity-error"
														: "text-muted-foreground",
												),
											),
										],
										[step.detail],
									),
								],
							),
							...(action === null ? [] : [h.div([h.Class("mt-2.5")], [action])]),
						],
					),
				],
			)
		}),
	)
