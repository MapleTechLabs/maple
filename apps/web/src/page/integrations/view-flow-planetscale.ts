import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { derivePlanetScaleSetup, metricsAuthOf } from "../../components/integrations/planetscale-setup-steps"
import { button } from "../../ui/button"
import * as Field from "../../ui/field"
import { icon } from "../../ui/icon"
import { input } from "../../ui/input"
import {
	type CheckRow,
	choiceTiles,
	flowColumns,
	flowRail,
	foundChips,
	liveChecklist,
	savedBanner,
	statusRow,
	stepCard,
	whereToFind,
} from "../kit/connect-flow"
import { catalogEntry } from "./catalog"
import type { FlowStage } from "./flow"
import {
	hasUnsavedChoice,
	inventoryCountsOf,
	isAccessBlocked,
	planetscaleChoice,
	planetscaleStatusOf,
} from "./flow-planetscale"
import { Message } from "./message"
import type { Model } from "./model"
import type { PlanetscaleMetricsMethod } from "./planetscale"
import { branchFields, branchPreviewOf, orgChoices } from "./view-planetscale-picker"

// PlanetScale in the connect flow: authorize (optionally a metrics token), pick the organization
// and branches, then watch access, the inventory and the first metrics land.

type H = HtmlBuilder<Message>

const DOCS_HREF = catalogEntry("planetscale").docsUrl
const DOCS = DOCS_HREF === undefined ? null : { label: "Setup docs", href: DOCS_HREF }

const readsRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "What Maple reads",
		items: [
			{
				icon: "DatabaseIcon",
				title: "Databases and branches",
				detail: "Names, regions, production flag",
			},
			{
				icon: "ChartLineIcon",
				title: "Query insights",
				detail: "Top queries per branch, from PlanetScale",
			},
			{
				icon: "ChartBarIcon",
				title: "Branch metrics",
				detail: "CPU, memory, connections, replication lag",
			},
			{ icon: "BellIcon", title: "Deploy events", detail: "Webhooks Maple registers on each database" },
		],
		trust: "Read-only. Maple never changes your databases or schema. Revoke the grant in PlanetScale or disconnect from the source page.",
		timeNote: "Takes about 3 minutes",
		docs: DOCS,
	})

/** The Connect step's metrics choice: picked, else what the connection uses today. */
const metricsMethodOf = (model: Model, status: V2PlanetScaleIntegration): PlanetscaleMetricsMethod =>
	model.planetscaleCard.metricsMethod ?? metricsAuthOf(status)

const connectButton = (h: H, model: Model, label: string, variant: "default" | "outline"): Html =>
	button(
		h,
		{
			variant,
			size: variant === "outline" ? "sm" : undefined,
			className: "w-fit",
			isDisabled: model.connect.isStarting || model.disconnect.isPending,
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		variant === "outline"
			? [label]
			: [icon(h, "PlanetScaleIcon", { size: 14 }), label, icon(h, "ExternalLinkIcon", { size: 12 })],
	)

const authorizePart = (h: H, model: Model, status: V2PlanetScaleIntegration | null): Html => {
	if (status === null || (!status.connected && !status.pending_org_selection))
		return h.div(
			[h.Class("flex flex-col gap-3")],
			[
				h.p(
					[h.Class("text-sm text-muted-foreground")],
					[
						"PlanetScale opens in a new window. Approve read access for your organization. If the grant covers several organizations, you pick one on the next step.",
					],
				),
				connectButton(h, model, "Continue with PlanetScale", "default"),
			],
		)
	if (status.revoked_at !== null)
		return h.div(
			[h.Class("flex flex-col gap-3")],
			[
				h.p(
					[h.Class("text-sm text-muted-foreground")],
					[
						"The authorization was revoked in PlanetScale, so Maple can no longer read this organization.",
					],
				),
				connectButton(h, model, "Reconnect PlanetScale", "default"),
			],
		)
	if (status.detected_permissions?.readDatabases === false)
		return h.div(
			[h.Class("flex flex-col gap-3")],
			[
				h.p(
					[h.Class("text-sm text-muted-foreground")],
					[
						`The grant for ${status.organization ?? "this organization"} was approved without the read_databases scope, so Maple cannot list databases, branches or query insights. Keep every box checked when PlanetScale asks.`,
					],
				),
				connectButton(h, model, "Reconnect with read_databases", "default"),
			],
		)
	return h.div(
		[h.Class("flex items-center justify-between gap-3")],
		[
			h.span(
				[h.Class("inline-flex items-center gap-2 text-sm")],
				[
					icon(h, "CircleCheckIcon", { size: 14, className: "text-severity-info" }),
					status.organization === null ? "Authorized" : `Authorized for ${status.organization}`,
				],
			),
			connectButton(h, model, "Reconnect", "outline"),
		],
	)
}

const tokenField = (
	h: H,
	model: Model,
	field: "id" | "secret",
	options: Readonly<{ label: string; placeholder: string }>,
): Html => {
	const card = model.planetscaleCard
	const fieldModel = field === "id" ? card.tokenId : card.tokenSecret
	const state = Field.stateOf(fieldModel, false)
	const ids: Field.FieldIds = {
		control: `ps-token-${field}`,
		label: `ps-token-${field}-label`,
		error: `ps-token-${field}-error`,
	}
	return Field.field(h, { className: "items-stretch gap-1.5", state }, [
		Field.fieldLabel(h, { ids, state }, options.label),
		input(h, {
			id: ids.control,
			type: field === "secret" ? "password" : "text",
			fieldState: state,
			attributes: [
				h.Autocomplete("off"),
				h.Placeholder(options.placeholder),
				...Field.controlAttributes(h, fieldModel, (message) =>
					Message.GotPlanetscaleTokenField({ field, message }),
				),
				h.AriaLabelledBy(ids.label),
			],
		}),
	])
}

const tokenForm = (h: H, model: Model, status: V2PlanetScaleIntegration, isAttached: boolean): Html => {
	const card = model.planetscaleCard
	const isReady = card.tokenId.value.trim() !== "" && card.tokenSecret.value.trim() !== ""
	const tokensUrl =
		status.organization === null
			? "https://app.planetscale.com"
			: `https://app.planetscale.com/${encodeURIComponent(status.organization)}/settings/service-tokens`
	return h.form(
		[h.Class("flex flex-col gap-4"), h.OnSubmit(Message.SubmittedPlanetscaleToken())],
		[
			h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground")],
				[
					h.span(
						[],
						[
							"Give the token one permission on every database you want metrics for: ",
							h.span([h.Class("font-mono text-foreground")], ["read_metrics_endpoints"]),
						],
					),
					whereToFind(h, "Create a token in PlanetScale", tokensUrl),
				],
			),
			h.div(
				[h.Class("grid grid-cols-1 gap-3 @2xl/page:grid-cols-2")],
				[
					tokenField(h, model, "id", { label: "Service token ID", placeholder: "Token ID" }),
					tokenField(h, model, "secret", {
						label: "Service token secret",
						placeholder: "pscale_tkn_...",
					}),
				],
			),
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					button(h, { type: "submit", isDisabled: !isReady, isLoading: card.isSavingToken }, [
						icon(h, "KeyIcon", { size: 14 }),
						card.tokenError === null ? "Check and save token" : "Check token again",
					]),
					...(isAttached
						? [
								button(
									h,
									{
										variant: "outline",
										isDisabled: card.isSavingToken,
										attributes: [h.OnClick(Message.ClickedPlanetscaleReplaceToken())],
									},
									["Cancel"],
								),
							]
						: []),
				],
			),
		],
	)
}

const metricsPart = (h: H, model: Model, status: V2PlanetScaleIntegration): Html => {
	const isAttached = metricsAuthOf(status) === "service_token"
	const method = metricsMethodOf(model, status)
	const select = (next: PlanetscaleMetricsMethod) =>
		isAttached ? undefined : Message.SelectedPlanetscaleMetricsMethod({ method: next })
	return h.div(
		[h.Class("flex flex-col gap-3 border-t border-border pt-5")],
		[
			h.h3([h.Class("text-sm font-medium")], ["Branch metrics"]),
			choiceTiles(h, [
				{
					title: "PlanetScale metrics API",
					description: "Maple polls it on this grant every 5 minutes. Nothing to paste.",
					tag: "Recommended",
					isSelected: method === "api",
					onSelect: select("api"),
				},
				{
					title: "Service token",
					description:
						"Scrapes the Prometheus endpoints instead. Needs a token with one permission.",
					isSelected: method === "service_token",
					onSelect: select("service_token"),
				},
			]),
			...(method !== "service_token"
				? []
				: isAttached && !model.planetscaleCard.isReplacingToken
					? [
							h.div(
								[h.Class("flex items-center justify-between gap-3")],
								[
									h.span(
										[h.Class("text-sm text-muted-foreground")],
										["A service token is attached. Branch metrics are scraped with it."],
									),
									button(
										h,
										{
											variant: "outline",
											size: "sm",
											attributes: [h.OnClick(Message.ClickedPlanetscaleReplaceToken())],
										},
										["Use a different token"],
									),
								],
							),
						]
					: [tokenForm(h, model, status, isAttached)]),
		],
	)
}

/** The databases the inventory found, as chips under the status row. */
const databaseChips = (h: H, model: Model): ReadonlyArray<Html> => {
	const inventory = model.statuses.planetscaleDatabases.data
	const databases =
		AsyncData.isSuccess(inventory) || AsyncData.isRefreshing(inventory) ? inventory.data.databases : []
	return databases.length === 0
		? []
		: [
				foundChips(
					h,
					databases.slice(0, 8).map((db) => ({
						label: db.name,
						detail: countLabel(db.branches.length, "branch", "branches"),
					})),
				),
			]
}

const connectStatus = (h: H, model: Model, status: V2PlanetScaleIntegration | null): Html => {
	const card = model.planetscaleCard
	if (model.connect.isStarting)
		return statusRow(h, { tone: "working", text: "Waiting for you to approve in PlanetScale…" })
	if (status === null || (!status.connected && !status.pending_org_selection))
		return statusRow(h, {
			tone: "idle",
			text: "Not authorized yet. This step moves on by itself when you approve in PlanetScale.",
		})
	if (status.revoked_at !== null)
		return statusRow(h, {
			tone: "error",
			text: "Blocked. The authorization was revoked, so collection is paused until you reconnect.",
		})
	if (status.detected_permissions?.readDatabases === false)
		return statusRow(h, {
			tone: "error",
			text: `Blocked. The grant for ${status.organization ?? "this organization"} cannot read databases, so Maple cannot list databases or branches.`,
		})
	if (card.isSavingToken)
		return statusRow(h, { tone: "working", text: "Checking the token with PlanetScale…" })
	if (card.tokenError !== null)
		return statusRow(h, {
			tone: "error",
			text: `PlanetScale rejected this token: ${card.tokenError} Nothing was saved; the authorization is kept.`,
		})
	if (!status.connected)
		return statusRow(h, {
			tone: "ok",
			text: "Authorized. The grant covers several organizations; pick one on the next step.",
		})
	const counts = inventoryCountsOf(model)
	return statusRow(
		h,
		{
			tone: "ok",
			text: `Authorized for ${status.organization ?? "your organization"}${
				counts === null ? "." : `. Found ${countLabel(counts.databases, "database")}.`
			}`,
		},
		databaseChips(h, model),
	)
}

const connectStep = (h: H, model: Model): Html => {
	const status = planetscaleStatusOf(model)
	const canPickMetrics = status !== null && status.connected && !isAccessBlocked(status)
	return flowColumns(
		h,
		[
			stepCard(h, { icon: "PlanetScaleIcon", title: "Authorize PlanetScale", note: "Read-only" }, [
				authorizePart(h, model, status),
				...(canPickMetrics && status !== null ? [metricsPart(h, model, status)] : []),
			]),
			connectStatus(h, model, status),
		],
		readsRail(h),
	)
}

const chooseRail = (h: H, model: Model, status: V2PlanetScaleIntegration | null): Html => {
	const card = model.planetscaleCard
	const counts = inventoryCountsOf(model)
	const preview = branchPreviewOf(model)
	const viaToken = status !== null && metricsAuthOf(status) === "service_token"
	return flowRail(h, {
		eyebrow: "You are about to collect",
		items: [
			{ icon: "PlanetScaleIcon", title: "Organization", detail: card.selectedOrg ?? "Not picked yet" },
			{
				icon: "DatabaseIcon",
				title: "Databases",
				detail:
					counts === null
						? "Listed after the first inventory"
						: countLabel(counts.databases, "database"),
			},
			{
				icon: "BranchForkIcon",
				title: "Branches",
				detail: preview === null ? "Every branch" : `${preview.kept} of ${preview.total} matched`,
			},
			{
				icon: "ChartBarIcon",
				title: "Branch metrics",
				detail: viaToken ? "Scraped with the service token" : "Polled every 5 minutes",
			},
			{ icon: "ChartLineIcon", title: "Query insights", detail: "Every database in the organization" },
		],
		trust: "New branches that match the patterns are picked up on the next inventory refresh. Change any of this later from Edit data.",
		docs: DOCS,
	})
}

const chooseStatus = (h: H, model: Model, status: V2PlanetScaleIntegration | null): Html => {
	const card = model.planetscaleCard
	if (card.isSelecting) return statusRow(h, { tone: "working", text: "Saving the selection…" })
	if (status === null || card.selectedOrg === null)
		return statusRow(h, { tone: "idle", text: "Pick the organization Maple collects from." })
	if (!status.connected || hasUnsavedChoice(model, status))
		return statusRow(h, { tone: "idle", text: "Save to apply the selection." })
	return statusRow(h, {
		tone: "ok",
		text: `Collecting from ${status.organization ?? ""}: ${planetscaleChoice(model, status)}.`,
	})
}

const chooseStep = (h: H, model: Model): Html => {
	const status = planetscaleStatusOf(model)
	const card = model.planetscaleCard
	const organizations = card.organizations.data
	const orgCount =
		AsyncData.isSuccess(organizations) || AsyncData.isRefreshing(organizations)
			? organizations.data.organizations.length
			: null
	const isBound = status !== null && status.connected
	const canSave =
		card.selectedOrg !== null && (!isBound || (status !== null && hasUnsavedChoice(model, status)))
	return flowColumns(
		h,
		[
			stepCard(h, { icon: "PlanetScaleIcon", title: "Organization" }, [
				h.p(
					[h.Class("text-sm text-muted-foreground")],
					[
						orgCount !== null && orgCount > 1
							? `Your grant covers ${orgCount} organizations. One source watches one organization.`
							: "The organization this grant covers. One source watches one organization.",
					],
				),
				orgChoices(h, model),
			]),
			stepCard(h, { icon: "BranchForkIcon", title: "Which branches?" }, [
				branchFields(h, model),
				button(
					h,
					{
						className: "w-fit",
						isDisabled: !canSave,
						isLoading: card.isSelecting,
						attributes: [h.OnClick(Message.SubmittedOrganization())],
					},
					[isBound ? "Save" : "Start collecting"],
				),
			]),
			chooseStatus(h, model, status),
		],
		chooseRail(h, model, status),
	)
}

const showsUpRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "Where it shows up",
		items: [
			{
				icon: "ServerIcon",
				title: "Infrastructure, PlanetScale",
				detail: "One row per database, health per branch",
			},
			{
				icon: "LayersIcon",
				title: "Service map",
				detail: "Databases linked to the services that query them",
			},
			{ icon: "GearIcon", title: "Source page", detail: "Edit data, Reconnect, Disconnect" },
		],
		timeNote: "First metrics within 10 minutes",
		docs: DOCS,
	})

const liveStep = (h: H, model: Model): Html => {
	const status = planetscaleStatusOf(model)
	const setup =
		status === null || !status.connected
			? null
			: derivePlanetScaleSetup(status, model.nowMs, inventoryCountsOf(model))
	const rows: ReadonlyArray<CheckRow> =
		setup === null
			? [{ state: "waiting", title: "Waiting for PlanetScale's status" }]
			: setup.checks.map((check) =>
					check.id === "access" && check.state === "failed"
						? { ...check, extra: connectButton(h, model, "Reconnect", "outline") }
						: check,
				)
	return flowColumns(
		h,
		[
			savedBanner(
				h,
				"Saved as a source. Safe to leave; collection keeps running.",
				"Nothing to install in PlanetScale",
			),
			liveChecklist(h, {
				title: setup?.live === "healthy" ? "PlanetScale is live" : "Checking the connection",
				rows,
			}),
		],
		showsUpRail(h),
	)
}

export const planetscaleFlowView = (h: H, model: Model, stage: FlowStage): Html =>
	stage === "live" ? liveStep(h, model) : stage === "choose" ? chooseStep(h, model) : connectStep(h, model)
