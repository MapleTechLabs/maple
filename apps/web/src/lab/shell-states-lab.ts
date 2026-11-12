import { Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { button } from "@maple/views/ui/button"
import * as Dialog from "@maple/views/ui/dialog"
import { input } from "@maple/views/ui/input"
import { label } from "@maple/views/ui/label"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import {
	followUrl,
	isDismissed,
	mapSheetCommands,
	type SheetStep,
	sidePanelSheet,
} from "@maple/views/ui/sheet"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import * as TooltipHost from "@maple/views/ui/tooltip-host"
import { typography } from "@maple/views/ui/typography"
import type { Resources } from "../platform/resources"
import { dashboardPage } from "../page/kit/dashboard-page"
import { dismissSheetUrl, pushSheetUrl, sheetParamOf } from "../page/kit/sheet-param"
import { Message as ShellMessage, Theme } from "../shell/message"
import { init as initShell, Model as ShellModel, OnCallData, type ShellClerk } from "../shell/model"
import { NavAudience } from "../shell/nav"
import type { OnCallSnapshot } from "../shell/oncall"
import { foldLabShell, labShellView } from "./shell-frame"

// `/lab/shell`: the real sidebar with fixture on-call states and a page to stand on, and the side
// panel held in `?sheet=` (Back closes it, the link reopens it) in both of its sizes.

/** The `form` panel: also the Dialog's id. */
export const SHEET_ID = "new-alert-rule"
/** The `compact` panel. */
export const COMPACT_SHEET_ID = "snooze-rule"
const LAB_PATH = "/lab/shell"

export const OnCallFixture = Schema.Literals(["onCall", "onCallFar", "notOnCall", "none"])
export type OnCallFixture = typeof OnCallFixture.Type

export const StandOn = Schema.Literals(["lab", "alerts", "services", "logs"])
export type StandOn = typeof StandOn.Type

const STAND_ON_PATH = {
	lab: LAB_PATH,
	alerts: "/alerts",
	services: "/services",
	logs: "/logs",
} satisfies Record<StandOn, string>

/** Which panel the URL names. */
export const Panel = Schema.Literals(["rule", "snooze"])
export type Panel = typeof Panel.Type

const PANEL_ID = { rule: SHEET_ID, snooze: COMPACT_SHEET_ID } satisfies Record<Panel, string>

/** Mon 16 Nov 2099, 08:00 UTC (09:00 CET): far enough out that the fixture shift never ends. */
const HANDOFF_MS = Date.UTC(2099, 10, 16, 8)
const DAY_MS = 24 * 60 * 60_000
/** The lab's clock: three days before the handoff, so the near shift reads by its weekday. */
const LAB_NOW_MS = HANDOFF_MS - 3 * DAY_MS

const LAB_USER = "user_lab"

const shiftOf = (scheduleName: string, userId: string, endsAtMs: number) => ({
	scheduleName,
	userId,
	endsAtMs,
})

const SHIFTS = {
	onCall: [shiftOf("Checkout primary", LAB_USER, HANDOFF_MS)],
	// Over six days out, and a second schedule held at once.
	onCallFar: [
		shiftOf("Checkout primary", LAB_USER, HANDOFF_MS + 7 * DAY_MS),
		shiftOf("Payments", LAB_USER, HANDOFF_MS + 14 * DAY_MS),
	],
	notOnCall: [shiftOf("Checkout primary", "user_other", HANDOFF_MS)],
	none: [],
} satisfies Record<OnCallFixture, OnCallSnapshot["shifts"]>

export const onCallSnapshotOf = (fixture: OnCallFixture): OnCallSnapshot => ({
	userId: LAB_USER,
	viewerTimeZone: "Europe/Berlin",
	shifts: SHIFTS[fixture],
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
	/** The panel the sheet shows; kept through its exit transition. */
	panel: Panel,
	tooltip: TooltipHost.Model,
	href: Schema.String,
	onCall: OnCallFixture,
	standOn: StandOn,
	viewer: NavAudience,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotShellMessage: { message: ShellMessage },
	GotSheetMessage: { message: Dialog.Message },
	GotTooltipMessage: { message: TooltipHost.Message },
	/** The URL changed (a push, a replace, Back or Forward). */
	ChangedUrl: { href: Schema.String },
	ClickedOpenPanel: { panel: Panel },
	ClickedSubmitPanel: {},
	ClickedOnCallFixture: { fixture: OnCallFixture },
	ClickedStandOn: { standOn: StandOn },
	ClickedViewer: { viewer: NavAudience },
	CompletedNavigate: {},
})
export type Message = typeof Message.Type

const sheetArgs = { href: Schema.String, id: Schema.String }

/** Opening the sheet: a history entry carrying `?sheet=`, marked as this tab's. */
export const PushSheetUrl = Command.define("PushSheetUrl", {
	args: sheetArgs,
	messages: [Message.CompletedNavigate],
	execute: ({ href, id }) => pushSheetUrl(href, id).pipe(Effect.as(Message.CompletedNavigate())),
})

/** Dismissing it: back past the entry this tab pushed, else the param is replaced away. */
export const DismissSheetUrl = Command.define("DismissSheetUrl", {
	args: sheetArgs,
	messages: [Message.CompletedNavigate],
	execute: ({ href, id }) => dismissSheetUrl(href, id).pipe(Effect.as(Message.CompletedNavigate())),
})

type Return = Update.Return<Model, Message, Resources>

export const toShell = (message: ShellMessage): Message => Message.GotShellMessage({ message })
export const toTooltip = (message: TooltipHost.Message): Message => Message.GotTooltipMessage({ message })
const toSheet = (message: Dialog.Message): Message => Message.GotSheetMessage({ message })
const foldShell = foldLabShell<Model, Message>(toShell)

/** The panel `?sheet=` names, if it names one of the lab's. */
const panelInUrl = (href: string): Option.Option<Panel> =>
	Option.flatMap(sheetParamOf(href), (id) =>
		id === SHEET_ID
			? Option.some<Panel>("rule")
			: id === COMPACT_SHEET_ID
				? Option.some<Panel>("snooze")
				: Option.none(),
	)

const sheetStep = (model: Model, step: SheetStep): Return => ({
	model: { ...model, sheet: step.model },
	commands: [
		...mapSheetCommands(step, toSheet),
		...(isDismissed(step) ? [DismissSheetUrl({ href: model.href, id: PANEL_ID[model.panel] })] : []),
	],
})

/** A signed-in observer with nothing else read yet: all the shell needs to pick their sidebar. */
const OBSERVER_CLERK: ShellClerk = {
	maybeUser: Option.none(),
	maybeOrganization: Option.none(),
	memberships: [],
	customer: undefined,
	maybeRole: Option.some("org:observer"),
}

/** The fixture's shifts, read on the lab's fixed clock. */
const withOnCall = (shell: ShellModel, fixture: OnCallFixture): ShellModel => ({
	...shell,
	onCall: OnCallData.Success({ data: onCallSnapshotOf(fixture) }),
	onCallNowMs: LAB_NOW_MS,
})

/** No org: the shell sends nothing, so the fixtures are all it shows. */
export const init = (flags: Flags): Return => {
	const open = panelInUrl(flags.href)
	const sheet = followUrl(Dialog.init(SHEET_ID, "sheet"), Option.isSome(open))
	return {
		model: {
			shell: withOnCall(initShell(flags.shell), "onCall"),
			sheet: sheet.model,
			panel: Option.getOrElse(open, (): Panel => "rule"),
			tooltip: TooltipHost.init("tooltip"),
			href: flags.href,
			onCall: "onCall",
			standOn: "lab",
			viewer: "operator",
		},
		commands: mapSheetCommands(sheet, toSheet),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotShellMessage: ({ message: inner }) => foldShell(model, inner),
		GotSheetMessage: ({ message: inner }) => sheetStep(model, Dialog.update(model.sheet, inner)),
		GotTooltipMessage: ({ message: inner }) => {
			const next = TooltipHost.update(model.tooltip, inner)
			return {
				model: { ...model, tooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], toTooltip),
			}
		},
		ChangedUrl: ({ href }) => {
			const open = panelInUrl(href)
			const step = followUrl(model.sheet, Option.isSome(open))
			return {
				model: {
					...model,
					href,
					sheet: step.model,
					panel: Option.getOrElse(open, () => model.panel),
				},
				commands: mapSheetCommands(step, toSheet),
			}
		},
		ClickedOpenPanel: ({ panel }) => ({
			model,
			commands: [PushSheetUrl({ href: model.href, id: PANEL_ID[panel] })],
		}),
		ClickedSubmitPanel: () => sheetStep(model, Dialog.close(model.sheet)),
		ClickedOnCallFixture: ({ fixture }) => ({
			model: { ...model, onCall: fixture, shell: withOnCall(model.shell, fixture) },
		}),
		ClickedStandOn: ({ standOn }) => ({ model: { ...model, standOn } }),
		ClickedViewer: ({ viewer }) => ({ model: { ...model, viewer } }),
		CompletedNavigate: () => ({ model }),
	})

// VIEW

const control = <M>(h: HtmlBuilder<M>, title: string, body: Html): Html =>
	vstack(h, { gap: "2" }, [typography(h, { size: "sm", weight: "medium" }, [title]), body])

const field = <M>(h: HtmlBuilder<M>, id: string, text: string, control: Html): Html =>
	vstack(h, { gap: "2" }, [label(h, { attributes: [h.For(id)] }, [text]), control])

/** The `form` size: a full create form. */
const rulePanel = (h: HtmlBuilder<Message>, model: Model): Html =>
	sidePanelSheet(h, {
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
		footer: (close) => [
			button(h, { variant: "outline", attributes: close }, ["Cancel"]),
			button(h, { attributes: [h.OnClick(Message.ClickedSubmitPanel())] }, ["Create rule"]),
		],
	})

/** The `compact` size: two short fields. */
const snoozePanel = (h: HtmlBuilder<Message>, model: Model): Html =>
	sidePanelSheet(h, {
		sheet: model.sheet,
		size: "compact",
		title: "Snooze rule",
		description: "The rule keeps checking but pages no one until the snooze ends.",
		toParentMessage: toSheet,
		body: [
			vstack(h, { gap: "5" }, [
				field(
					h,
					"snooze-hours",
					"Hours",
					input(h, { id: "snooze-hours", attributes: [h.Value("4")] }),
				),
				field(
					h,
					"snooze-reason",
					"Reason",
					input(h, { id: "snooze-reason", attributes: [h.Placeholder("Deploying checkout")] }),
				),
			]),
		],
		footer: (close) => [
			button(h, { variant: "outline", attributes: close }, ["Cancel"]),
			button(h, { attributes: [h.OnClick(Message.ClickedSubmitPanel())] }, ["Snooze"]),
		],
	})

const page = (h: HtmlBuilder<Message>, model: Model): Html =>
	dashboardPage(
		h,
		{
			title: "Shell states",
			description: "Fold a sidebar group, switch the on-call fixture, or open a side panel.",
			actions: hstack(h, { gap: "2" }, [
				button(
					h,
					{
						variant: "outline",
						attributes: [h.OnClick(Message.ClickedOpenPanel({ panel: "snooze" }))],
					},
					["Snooze rule"],
				),
				button(h, { attributes: [h.OnClick(Message.ClickedOpenPanel({ panel: "rule" }))] }, [
					"New alert rule",
				]),
			]),
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
							{ value: "onCallFar", label: "On call, next week" },
							{ value: "notOnCall", label: "Not on call" },
							{ value: "none", label: "No schedules" },
						],
					}),
				),
				control(
					h,
					"Viewer",
					segmentedSelect(h, {
						ariaLabel: "Viewer",
						value: model.viewer,
						onChange: (viewer) => Message.ClickedViewer({ viewer }),
						options: [
							{ value: "operator", label: "Member and above" },
							{ value: "observer", label: "Observer" },
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
							{ value: "services", label: "Services (Monitor)" },
							{ value: "logs", label: "Logs (Analyze)" },
						],
					}),
				),
			]),
			model.panel === "snooze" ? snoozePanel(h, model) : rulePanel(h, model),
		],
	)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Id("app")],
		[
			TooltipHost.view(h, model.tooltip, toTooltip),
			...labShellView(h, model.shell, toShell, {
				currentPath: STAND_ON_PATH[model.standOn],
				clerk: model.viewer === "observer" ? OBSERVER_CLERK : null,
				breadcrumbs: [{ label: "Lab" }, { label: "Shell states" }],
				page: () => page(h, model),
			}),
		],
	)
