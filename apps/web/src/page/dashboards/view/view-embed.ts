import { ALL_VALUE, type ResolvedVariable } from "@maple/query-engine"
import { REFRESH_INTERVAL_OPTIONS } from "../../../lib/dashboard-controls/search-params"
import { highlightCode } from "../../../lib/sugar-high"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as DialogView from "../../../ui/dialog-view"
import { icon, type IconName } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import * as TabsView from "../../../ui/tabs-view"
import { truncatedText } from "../../../ui/truncated-text"
import type { PageContext } from "../../contract"
import { codeBlock } from "../../settings/kit/code-block"
import type { Variable } from "../kit/variables"
import { Message } from "./message"
import type { Model } from "./model"
import { optionsByNameOf, variablesOf } from "./plan"
import { boardShareOf, chartShareOf, embedUrl, ShareMessage } from "./share"
import { shareLinkRow } from "./view-share"

// The embed widget dialog.

type H = HtmlBuilder<Message>

const wrap = (message: ShareMessage) => Message.GotShareMessage({ message })

/** `YYYY-MM-DD HH:MM:SS` in UTC, the only shape the share API accepts. */
const warehouseDateTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

/** Sugar High tokenizes `400` and `border` flatly; recolour those two for this snippet only. */
const refineJsxTokens = (html: string) =>
	html
		.replace(
			/<span class="sh__token--identifier" style="color:var\(--sh-identifier\)">(\d+)<\/span>/g,
			'<span class="sh__token--keyword" style="color:var(--sh-keyword)">$1</span>',
		)
		.replace(
			/<span class="sh__token--identifier" style="color:var\(--sh-identifier\)">(\w+)<\/span>(?=<span class="sh__token--sign" style="color:var\(--sh-sign\)">:<\/span>)/g,
			'<span class="sh__token--property" style="color:var(--sh-property)">$1</span>',
		)

const iframeSnippet = (h: H, model: Model, url: string): Html => {
	const html = [
		"<iframe",
		`  src="${url}"`,
		'  width="100%"',
		'  height="400"',
		'  style="border: 0"',
		'  loading="lazy"',
		"></iframe>",
	].join("\n")
	const jsx = [
		"<iframe",
		`  src="${url}"`,
		'  width="100%"',
		"  height={400}",
		"  style={{ border: 0 }}",
		'  loading="lazy"',
		"/>",
	].join("\n")
	const copy = {
		copy: model.sharing.snippetCopy,
		toCopyMessage: (message: Parameters<typeof ShareMessage.GotSnippetCopyMessage>[0]["message"]) =>
			wrap(ShareMessage.GotSnippetCopyMessage({ message })),
	}
	return h.submodel({
		slotId: "dashboard-embed-tabs",
		model: model.sharing.embedTabs,
		view: TabsView.view,
		toParentMessage: (message) => wrap(ShareMessage.GotEmbedTabsMessage({ message })),
		viewInputs: {
			variant: "underline",
			labels: ["HTML", "React"],
			className: "gap-2",
			wrapList: (list) =>
				h.div(
					[h.Class("flex items-center justify-between gap-3")],
					[h.div([h.Class("font-medium text-xs")], ["Embed in a page"]), list],
				),
			panel: (value) =>
				value === "html"
					? [codeBlock(h, { code: html, language: "html", ...copy })]
					: [
							codeBlock(h, {
								code: jsx,
								language: "jsx",
								highlighted: refineJsxTokens(highlightCode(jsx)),
								...copy,
							}),
						],
		},
	})
}

const notPublicNotice = (h: H, isOrgOnly: boolean, isBusy: boolean): Html =>
	panel(h, { tone: "muted", className: "space-y-3 px-3.5 py-3" }, [
		h.div(
			[h.Class("flex items-start gap-3")],
			[
				icon(h, "GlobeIcon", { size: 15, className: "mt-0.5 shrink-0 text-muted-foreground" }),
				h.div(
					[h.Class("space-y-1")],
					[
						h.div(
							[h.Class("font-medium text-sm")],
							[
								isOrgOnly
									? "This dashboard is shared with your organization only"
									: "This dashboard isn't shared",
							],
						),
						h.p(
							[h.Class("text-muted-foreground text-xs leading-relaxed")],
							[
								"Embeds only work on public dashboards. Making it public lets anyone with the dashboard's link view all of it, not just this chart.",
							],
						),
					],
				),
			],
		),
		h.ol(
			[h.Class("ml-7 list-decimal space-y-0.5 pl-4 text-muted-foreground text-xs leading-relaxed")],
			[
				h.li([], ["Open the ⋮ menu in the dashboard header and choose Share…"]),
				h.li([], ['Select "Anyone with the link"']),
				h.li([], ["Reopen Embed chart from this chart's menu"]),
			],
		),
		h.div(
			[h.Class("ml-7")],
			[
				button(
					h,
					{
						size: "sm",
						variant: "destructive",
						isDisabled: isBusy,
						attributes: [h.OnClick(wrap(ShareMessage.ClickedMakePublic()))],
					},
					[icon(h, "GlobeIcon"), "Make dashboard public"],
				),
			],
		),
	])

type UrlOption = Readonly<{
	key: string
	icon: IconName
	param: string
	description: string
	example: string
	unavailable?: boolean
}>

/** An example for a variable: its current value, else its first option, else its default. */
const exampleValue = (
	variable: Variable,
	resolved: ResolvedVariable | undefined,
	options: ReadonlyArray<string> | undefined,
) =>
	resolved !== undefined && !resolved.isAll && resolved.value !== ""
		? resolved.value
		: options?.[0] || variable.defaultValue || (variable.type === "textbox" ? "value" : ALL_VALUE)

const urlOptions = (h: H, model: Model, context: PageContext): Html => {
	const now = model.sharing.embedNowMs
	const definitions = model.document?.variables ?? []
	const values = variablesOf(model, context).values
	const optionsByName = optionsByNameOf(model, context)
	const options: ReadonlyArray<UrlOption> = [
		{
			key: "theme",
			icon: "SunIcon",
			param: "theme",
			description: "light or dark",
			example: "&theme=light",
		},
		{
			key: "range",
			icon: "ClockIcon",
			param: "range",
			description: "Relative window: 30m, 24h, 7d, 2w or today. Defaults to the dashboard's range",
			example: "&range=7d",
		},
		{
			key: "from-to",
			icon: "ClockIcon",
			param: "from, to",
			description: "Fixed window in UTC, set both. Overrides range",
			example: `&from=${warehouseDateTime(now - 12 * 3600_000)}&to=${warehouseDateTime(now)}`,
		},
		{
			key: "refresh",
			icon: "ArrowRotateClockwiseIcon",
			param: "refresh",
			description: `Seconds: ${REFRESH_INTERVAL_OPTIONS.filter((value) => value > 0).join(", ")}. 0 turns it off`,
			example: "&refresh=60",
		},
		...(definitions.length === 0
			? [
					{
						key: "var",
						icon: "BracketsCurlyIcon" as const,
						param: "var-<name>",
						description: "Not available, this dashboard has no variables",
						example: "&var-service=checkout",
						unavailable: true,
					},
				]
			: definitions.map((variable) => ({
					key: `var-${variable.name}`,
					icon: "BracketsCurlyIcon" as const,
					param: `var-${variable.name}`,
					description: variable.label ?? "Dashboard variable",
					example: `&var-${variable.name}=${exampleValue(variable, values[variable.name], optionsByName[variable.name]?.options)}`,
				}))),
	]
	return h.div(
		[h.Class("space-y-2")],
		[
			h.div(
				[],
				[
					h.div([h.Class("font-medium text-xs")], ["URL options"]),
					h.p(
						[h.Class("text-muted-foreground text-xs")],
						["Append any of these to the embed link."],
					),
				],
			),
			h.ul(
				[h.Class("divide-y divide-border overflow-hidden rounded-md border")],
				options.map((option) =>
					h.li(
						[
							h.Class(
								cn(
									"grid grid-cols-[1rem_6.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 px-3 py-2.5 text-xs leading-5",
									option.unavailable === true && "opacity-60",
								),
							),
						],
						[
							h.span(
								[h.Class("flex h-5 items-center text-muted-foreground")],
								[icon(h, option.icon, { size: 14 })],
							),
							truncatedText(h, { text: option.param, className: "font-medium font-mono" }),
							h.span([h.Class("text-muted-foreground")], [option.description]),
							inlineCode(
								h,
								{
									className:
										"col-start-3 w-fit max-w-full truncate px-1.5 text-2xs text-muted-foreground",
								},
								[option.example],
							),
						],
					),
				),
			),
		],
	)
}

const embedContent = (h: H, model: Model, context: PageContext): ReadonlyArray<Html> => {
	const widgetId = model.sharing.embedWidgetId ?? ""
	const shares = AsyncData.getOrElse(model.sharing.shares, () => [])
	const listError = AsyncData.isFailure(model.sharing.shares) ? model.sharing.shares.error.message : null
	const boardMode = boardShareOf(shares)?.mode
	const share = chartShareOf(shares, widgetId)
	const error = listError ?? model.sharing.error
	const body =
		listError !== null
			? []
			: boardMode !== "public"
				? [notPublicNotice(h, boardMode === "org", model.sharing.isBusy)]
				: share !== undefined
					? [
							...shareLinkRow(
								h,
								model,
								embedUrl(model.sharing.origin, share.token),
								"Every existing embed of this chart stops working until it is updated with the new link.",
							),
							iframeSnippet(h, model, embedUrl(model.sharing.origin, share.token)),
							urlOptions(h, model, context),
						]
					: model.sharing.error !== null
						? []
						: [skeleton(h, "h-8 rounded-lg sm:h-7")]
	return [...body, ...(error === null ? [] : [h.p([h.Class(cn(TONE_TEXT.crit, "text-xs"))], [error])])]
}

export const embedDialog = (h: H, model: Model, context: PageContext): Html => {
	const id = model.sharing.embedDialog.id
	return h.submodel({
		slotId: "dashboard-embed-dialog",
		model: model.sharing.embedDialog,
		view: DialogView.view,
		toParentMessage: (message) => wrap(ShareMessage.GotEmbedDialogMessage({ message })),
		viewInputs: {
			hasTrigger: false,
			hasDescription: true,
			className: "sm:max-w-xl",
			nestedDialogs: model.sharing.replaceDialog.isOpen ? 1 : 0,
			toView: ({ portal }) => portal,
			toContent: (close) => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", id, "Embed chart"),
					DialogView.dialogDescription(
						h,
						"dialog",
						id,
						"Anyone with the link can view this chart. It stops working while the dashboard is not public.",
					),
				]),
				DialogView.dialogPanel(h, "dialog", id, embedContent(h, model, context), "space-y-4"),
				DialogView.dialogFooter(h, "dialog", [
					button(h, { variant: "outline", attributes: close }, ["Done"]),
				]),
			],
		},
	})
}
