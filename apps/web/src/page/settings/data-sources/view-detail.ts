import type { V2DataSource, V2DataSourceTestResult } from "@maple/domain/http/v2"
import { Array as Arr, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { icon } from "@maple/views/ui/icon"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { relativeTime } from "../../kit/relative-time"
import { settingsSection, settingsSections } from "../kit/section"
import { Message, type Model } from "./model"
import { catalogSection } from "./view-catalog"
import { agentAccessLabel, environmentBadge, type Inputs, kindBadge, statusLine } from "./view-parts"

type H = HtmlBuilder<Message>

const connectionRows = (h: H, source: V2DataSource): ReadonlyArray<Html> =>
	source.connection.type === "clickhouse"
		? [
				keyValue(h, { label: "URL", mono: true, wrap: true }, [source.connection.url]),
				keyValue(h, { label: "User", mono: true }, [source.connection.user]),
				keyValue(h, { label: "Database", mono: true }, [source.connection.database]),
				keyValue(h, { label: "Password", mono: true }, [secretLabel(source)]),
			]
		: [
				keyValue(h, { label: "Instance" }, [
					source.connection.instance === "production" ? "Production" : "Development",
				]),
				keyValue(h, { label: "Secret key", mono: true }, [secretLabel(source)]),
			]

/** "ending x9Qa" for keys, "Set" for short passwords that get no hint, "None" when nothing is stored. */
const secretLabel = (source: { readonly has_secret: boolean; readonly secret_hint: string | null }): string =>
	!source.has_secret ? "None" : source.secret_hint === null ? "Set" : `ending ${source.secret_hint}`

/** The last test this visit: latency and warnings, or what the source said. */
export const testResult = (h: H, result: V2DataSourceTestResult): Html =>
	result.ok
		? alert(h, { variant: result.warnings.length > 0 ? "warn" : "info", role: "status" }, [
				icon(h, result.warnings.length > 0 ? "CircleWarningIcon" : "CircleCheckIcon"),
				alertTitle(h, [`Connected in ${Math.round(result.latency_ms)} ms`]),
				...(result.warnings.length === 0
					? []
					: [
							alertDescription(
								h,
								Arr.map(result.warnings, (warning) => h.p([], [warning])),
							),
						]),
			])
		: alert(h, { variant: "crit", role: "status" }, [
				icon(h, "CircleXmarkIcon"),
				alertTitle(h, ["The test failed"]),
				alertDescription(h, [result.error ?? "The source did not answer."]),
			])

/** The connect-time test passed but warned, e.g. the user can write. */
const savedWithWarnings = (h: H, warnings: ReadonlyArray<string>): Html =>
	alert(h, { variant: "warn", role: "status" }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, ["Connected, with a warning"]),
		alertDescription(
			h,
			Arr.map(warnings, (warning) => h.p([], [warning])),
		),
	])

const actions = (h: H, model: Model, source: V2DataSource): Html =>
	hstack(h, { gap: "2", wrap: true }, [
		button(
			h,
			{
				variant: "outline",
				size: "sm",
				isLoading: model.testingId === source.id,
				attributes: [h.OnClick(Message.ClickedTest({ id: source.id }))],
			},
			["Test connection"],
		),
		button(
			h,
			{
				variant: "outline",
				size: "sm",
				attributes: [h.OnClick(Message.ClickedEdit({ id: source.id }))],
			},
			[icon(h, "PencilIcon"), "Edit"],
		),
		button(
			h,
			{ variant: "destructive-outline", size: "sm", attributes: [h.OnClick(Message.ClickedDelete())] },
			[icon(h, "TrashIcon"), "Delete"],
		),
	])

const overview = (h: H, model: Model, source: V2DataSource, inputs: Inputs): Html => {
	const test = Arr.findFirst(model.tests, (outcome) => outcome.id === source.id)
	return settingsSection(h, { id: "data-source-overview", title: source.name, framed: false }, [
		vstack(h, { gap: "3" }, [
			hstack(h, { gap: "2", wrap: true }, [
				kindBadge(h, source.kind),
				environmentBadge(h, source.environment),
				statusLine(h, source),
			]),
			typography(h, { size: "sm", as: "p", className: "font-prose" }, [source.description]),
			...(source.status === "error" && source.last_error !== null && Option.isNone(test)
				? [
						alert(h, { variant: "crit" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, ["Last check failed"]),
							alertDescription(h, [source.last_error]),
						]),
					]
				: []),
			...Option.match(test, { onNone: () => [], onSome: (outcome) => [testResult(h, outcome.result)] }),
			...(model.saveWarnings !== null && model.saveWarnings.id === source.id && Option.isNone(test)
				? [savedWithWarnings(h, model.saveWarnings.warnings)]
				: []),
			keyValueList(h, { divided: true }, [
				...connectionRows(h, source),
				keyValue(h, { label: "Agents" }, [agentAccessLabel(source)]),
				...(source.tags.length === 0
					? []
					: [keyValue(h, { label: "Tags" }, [Arr.join(source.tags, ", ")])]),
				keyValue(h, { label: "Last checked" }, [
					source.last_checked_at === null
						? "Never"
						: relativeTime(h, {
								value: source.last_checked_at,
								nowMs: inputs.nowMs,
								timeZone: inputs.timeZone,
							}),
				]),
			]),
			...(inputs.canManage ? [actions(h, model, source)] : []),
		]),
	])
}

export const detailView = (h: H, model: Model, source: V2DataSource, inputs: Inputs): Html =>
	vstack(h, { gap: "6" }, [
		hstack(h, {}, [
			button(h, { variant: "ghost", size: "sm", attributes: [h.OnClick(Message.ClickedBack())] }, [
				icon(h, "ArrowLeftIcon"),
				"All data sources",
			]),
		]),
		settingsSections(h, [overview(h, model, source, inputs), catalogSection(h, model, source, inputs)]),
		confirmDialog(h, {
			slotId: "data-source-delete-dialog",
			model: model.deleteDialog,
			toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
			title: `Delete ${source.name}?`,
			description:
				"Maple forgets the connection, its stored secret and the catalog notes. Dashboards and alerts that query it stop working. Nothing changes in the source itself.",
			confirmLabel: "Delete",
			onConfirm: Message.ClickedConfirmDelete(),
			isPending: model.isDeleting,
		}),
	])
