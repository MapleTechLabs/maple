import { Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { pushUrl, replaceUrl } from "foldkit/navigation"
import { button } from "@maple/views/ui/button"
import * as Dialog from "@maple/views/ui/dialog"
import { input } from "@maple/views/ui/input"
import { label } from "@maple/views/ui/label"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { followUrl, isDismissed, mapSheetCommands, rightSheet, type SheetStep } from "@maple/views/ui/sheet"
import { vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import { typography } from "@maple/views/ui/typography"
import type { Resources } from "../platform/resources"
import { dashboardPage } from "../page/kit/dashboard-page"
import { sheetParamOf, withSheetParam } from "../page/kit/sheet-param"
import { Message as ShellMessage, Theme } from "../shell/message"
import { init as initShell, Model as ShellModel, OnCallData } from "../shell/model"
import type { OnCallSnapshot } from "../shell/oncall"
import { foldLabShell, labShellView } from "./shell-frame"

// `/lab/shell`: the real sidebar with fixture on-call states and a page to stand on, and the
// right sheet held in `?sheet=` (Back closes it, the link reopens it).

export const SHEET_ID = "new-alert-rule"
const LAB_PATH = "/lab/shell"

export const OnCallFixture = Schema.Literals(["onCall", "notOnCall", "none"])
export type OnCallFixture = typeof OnCallFixture.Type

export const StandOn = Schema.Literals(["lab", "alerts"])
export type StandOn = typeof StandOn.Type

/** Mon 16 Nov 2026, 08:00 UTC: 09:00 on the schedule's Berlin clock. */
const HANDOFF_MS = Date.UTC(2026, 10, 16, 8)

const LAB_USER = "user_lab"

export const onCallSnapshotOf = (fixture: OnCallFixture): OnCallSnapshot => ({
	userId: LAB_USER,
	shifts:
		fixture === "none"
			? []
			: [
					{
						scheduleName: "Checkout primary",
						timeZone: "Europe/Berlin",
						userId: fixture === "onCall" ? LAB_USER : "user_other",
						endsAtMs: HANDOFF_MS,
					},
				],
})

export const Flags = Schema.Struct({
	shell: Schema.Struct({
		isMobile: Schema.Boolean,
		theme: Theme,
		pinnedNamespaces: Schema.Record(Schema.String, Schema.String),
		dashboardFavorites: Schema.Array(Schema.String),
		collapsedNavGroups: Schema.optionalKey(Schema.Array(Schema.String)),
	}),
	href: Schema.String,
})
export type Flags = typeof Flags.Type

export const Model = Schema.Struct({
	shell: ShellModel,
	sheet: Dialog.Model,
	href: Schema.String,
	onCall: OnCallFixture,
	standOn: StandOn,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotShellMessage: { message: ShellMessage },
	GotSheetMessage: { message: Dialog.Message },
	/** The URL changed (a push, a replace, Back or Forward). */
	ChangedUrl: { href: Schema.String },
	ClickedNewRule: {},
	ClickedCreateRule: {},
	ClickedOnCallFixture: { fixture: OnCallFixture },
	ClickedStandOn: { standOn: StandOn },
	CompletedNavigate: {},
})
export type Message = typeof Message.Type

/** Opening the sheet: a new history entry carrying `?sheet=`. */
export const PushSheetUrl = Command.define("PushSheetUrl", {
	args: { url: Schema.String },
	messages: [Message.CompletedNavigate],
	execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigate())),
})

/** Dismissing it: the param leaves in place. */
export const ReplaceSheetUrl = Command.define("ReplaceSheetUrl", {
	args: { url: Schema.String },
	messages: [Message.CompletedNavigate],
	execute: ({ url }) => replaceUrl(url).pipe(Effect.as(Message.CompletedNavigate())),
})

type Return = Update.Return<Model, Message, Resources>

export const toShell = (message: ShellMessage): Message => Message.GotShellMessage({ message })
const toSheet = (message: Dialog.Message): Message => Message.GotSheetMessage({ message })
const foldShell = foldLabShell<Model, Message>(toShell)

const isSheetInUrl = (href: string): boolean => Option.contains(sheetParamOf(href), SHEET_ID)

const sheetStep = (model: Model, step: SheetStep): Return => ({
	model: { ...model, sheet: step.model },
	commands: [
		...mapSheetCommands(step, toSheet),
		...(isDismissed(step) ? [ReplaceSheetUrl({ url: withSheetParam(model.href, undefined) })] : []),
	],
})

const withOnCall = (shell: ShellModel, fixture: OnCallFixture): ShellModel => ({
	...shell,
	onCall: OnCallData.Success({ data: onCallSnapshotOf(fixture) }),
})

/** No org: the shell sends nothing, so the fixtures are all it shows. */
export const init = (flags: Flags): Return => {
	const sheet = followUrl(Dialog.init(SHEET_ID, "sheet"), isSheetInUrl(flags.href))
	return {
		model: {
			shell: withOnCall(initShell(flags.shell), "onCall"),
			sheet: sheet.model,
			href: flags.href,
			onCall: "onCall",
			standOn: "lab",
		},
		commands: mapSheetCommands(sheet, toSheet),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotShellMessage: ({ message: inner }) => foldShell(model, inner),
		GotSheetMessage: ({ message: inner }) => sheetStep(model, Dialog.update(model.sheet, inner)),
		ChangedUrl: ({ href }) => {
			const step = followUrl(model.sheet, isSheetInUrl(href))
			return { model: { ...model, href, sheet: step.model }, commands: mapSheetCommands(step, toSheet) }
		},
		ClickedNewRule: () => ({
			model,
			commands: [PushSheetUrl({ url: withSheetParam(model.href, SHEET_ID) })],
		}),
		ClickedCreateRule: () => sheetStep(model, Dialog.close(model.sheet)),
		ClickedOnCallFixture: ({ fixture }) => ({
			model: { ...model, onCall: fixture, shell: withOnCall(model.shell, fixture) },
		}),
		ClickedStandOn: ({ standOn }) => ({ model: { ...model, standOn } }),
		CompletedNavigate: () => ({ model }),
	})

// VIEW

const control = <M>(h: HtmlBuilder<M>, title: string, body: Html): Html =>
	vstack(h, { gap: "2" }, [typography(h, { size: "sm", weight: "medium" }, [title]), body])

const field = <M>(h: HtmlBuilder<M>, id: string, text: string, control: Html): Html =>
	vstack(h, { gap: "2" }, [label(h, { attributes: [h.For(id)] }, [text]), control])

const sheet = (h: HtmlBuilder<Message>, model: Model): Html =>
	rightSheet(h, {
		sheet: model.sheet,
		title: "New alert rule",
		description: "Page the on-call person when a service's error rate crosses a threshold.",
		toParentMessage: toSheet,
		body: [
			vstack(h, { gap: "5" }, [
				field(
					h,
					"rule-name",
					"Name",
					input(h, { id: "rule-name", attributes: [h.Placeholder("Checkout error rate")] }),
				),
				field(
					h,
					"rule-service",
					"Service",
					input(h, { id: "rule-service", attributes: [h.Placeholder("checkout-svc")] }),
				),
				field(
					h,
					"rule-threshold",
					"Error rate above (%)",
					input(h, { id: "rule-threshold", attributes: [h.Value("5")] }),
				),
				field(
					h,
					"rule-notes",
					"Notes for the responder",
					textarea(h, { id: "rule-notes", attributes: [h.Placeholder("What to check first")] }),
				),
			]),
		],
		footer: [
			button(
				h,
				{ variant: "outline", attributes: [h.OnClick(toSheet(Dialog.Message.ClickedClose()))] },
				["Cancel"],
			),
			button(h, { attributes: [h.OnClick(Message.ClickedCreateRule())] }, ["Create rule"]),
		],
	})

const page = (h: HtmlBuilder<Message>, model: Model): Html =>
	dashboardPage(
		h,
		{
			title: "Shell states",
			description: "Fold a sidebar group, switch the on-call fixture, or open the sheet.",
			actions: button(h, { attributes: [h.OnClick(Message.ClickedNewRule())] }, ["New alert rule"]),
		},
		[
			vstack(h, { gap: "6" }, [
				control(
					h,
					"On-call pill",
					segmentedSelect(h, {
						ariaLabel: "On-call fixture",
						value: model.onCall,
						onChange: (fixture) => Message.ClickedOnCallFixture({ fixture }),
						options: [
							{ value: "onCall", label: "On call" },
							{ value: "notOnCall", label: "Not on call" },
							{ value: "none", label: "No schedules" },
						],
					}),
				),
				control(
					h,
					"Current page",
					segmentedSelect(h, {
						ariaLabel: "Current page",
						value: model.standOn,
						onChange: (standOn) => Message.ClickedStandOn({ standOn }),
						options: [
							{ value: "lab", label: "Lab (no group)" },
							{ value: "alerts", label: "Alerts (Triage)" },
						],
					}),
				),
			]),
			sheet(h, model),
		],
	)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Id("app")],
		labShellView(h, model.shell, toShell, {
			currentPath: model.standOn === "alerts" ? "/alerts" : LAB_PATH,
			breadcrumbs: [{ label: "Lab" }, { label: "Shell states" }],
			page: () => page(h, model),
		}),
	)
