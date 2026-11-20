import type {
	FleetDevicesConnection,
	FleetPolicyFinding,
	FleetVulnerabilityFinding,
} from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { badge } from "@maple/views/ui/display"
import {
	empty,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { hstack, vstack } from "@maple/views/ui/stack"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import type { PageViewInputs } from "../../contract"
import { expandChevron } from "../../kit/expand-chevron"
import { integrationConnectCta } from "../../kit/integration-empty"
import { providerBrand } from "../../kit/providers"
import { relativeTime } from "../../kit/relative-time"
import { sectionHeading } from "../../kit/section-heading"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { securityLayout, WIDE_COLUMN } from "../kit/layout"
import { placeholderRows } from "../kit/parts"
import {
	criticalCount,
	cvssTone,
	devicesLabel,
	failingLabel,
	FLEET_CARD_HREF,
	fleetVulnerabilitiesHref,
	hasScores,
	knownExploitedCount,
	platformLabel,
	screenOf,
	serverNameOf,
	softwareLabel,
} from "./derive"
import { type Devices, Message, type Model } from "./model"

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const external = (h: H) => [h.Target("_blank"), h.Rel("noopener noreferrer")]

const SCORE_TONE = { crit: "error", warn: "warning", neutral: "foreground" } as const

const notConnected = (h: H): Html =>
	integrationConnectCta(h, {
		brand: providerBrand("fleet"),
		features: [
			{
				label: "Policies",
				title: "Failing device policies",
				description: "Each policy your devices fail, critical first, with the devices that fail it.",
			},
			{
				label: "Vulnerabilities",
				title: "Vulnerable software",
				description:
					"CVEs in the software installed on your devices, and the version that fixes each.",
			},
			{
				label: "Audit log",
				title: "Fleet admin activity",
				description: "Who changed what on your Fleet server, beside Maple's own audit log.",
			},
		],
		hint: "Read-only. Connect your Fleet server with an API-only Observer token; devices show here within a few minutes.",
		label: "Connect Fleet",
		href: FLEET_CARD_HREF,
	})

const forbidden = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "LockIcon")]),
				emptyTitle(h, ["Security is visible to org admins and engineers only"]),
				emptyDescription(h, [
					"Device findings name your team's machines and what is wrong with them, so only admins and engineers can open Security. Ask an admin of this organization for access.",
				]),
			]),
		],
		emptyFrameClass("dashed"),
	)

const firstSyncPending = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "HistoryIcon")]),
				emptyTitle(h, ["Waiting for the first sync"]),
				emptyDescription(h, [
					"Maple reads your Fleet server within about five minutes of connecting, then every hour. Failing policies and vulnerable software show here once the first sync is done.",
				]),
			]),
		],
		emptyFrameClass("dashed"),
	)

const authFailedNotice = (h: H, hasFindings: boolean): Html =>
	alert(h, { variant: "crit", size: "sm" }, [
		icon(h, "LockIcon"),
		alertTitle(h, ["Fleet rejected the saved token"]),
		alertDescription(h, [
			hasFindings
				? "Syncing is paused, so what shows here is from the last sync. "
				: "Nothing syncs until a new token is saved. ",
			textLink(h, { href: FLEET_CARD_HREF }, ["Save a new token"]),
		]),
	])

const syncErrorNotice = (h: H, error: string): Html =>
	alert(h, { variant: "warn", size: "sm" }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, ["The last sync failed"]),
		alertDescription(h, [
			`${error} Showing what the last good sync found; Maple tries again within the hour.`,
		]),
	])

/** The server's name, linking to it, and how long ago it was read. */
const serverLine = (h: H, connection: FleetDevicesConnection, clock: Clock): Html =>
	hstack(h, { gap: "1.5", align: "center", wrap: true }, [
		typography(h, { size: "xs", tone: "muted" }, ["Fleet server"]),
		typography(h, { size: "xs", weight: "medium" }, [
			textLink(h, { href: connection.baseUrl, tone: "inherit", attributes: external(h) }, [
				serverNameOf(connection),
			]),
		]),
		...(connection.syncedAt === null
			? []
			: [
					typography(h, { size: "xs", tone: "muted" }, [
						"· ",
						relativeTime(h, { value: connection.syncedAt, ...clock, prefix: "synced" }),
					]),
				]),
	])

const summary = (h: H, connection: FleetDevicesConnection, devices: Devices): Html => {
	const scored = hasScores(devices.vulnerabilities)
	const critical = criticalCount(devices.policies)
	const exploited = knownExploitedCount(devices.vulnerabilities)
	const cves = devices.vulnerabilities.length + devices.moreVulnerabilities
	return statRail(h, { columns: scored ? 5 : 4, className: "grid-cols-2" }, [
		statRailItem(h, {
			eyebrow: "Enrolled devices",
			value: connection.hostCount === null ? "Not counted" : formatNumber(connection.hostCount),
			compact: true,
		}),
		statRailItem(h, {
			eyebrow: "Failing policies",
			value: formatNumber(devices.policies.length),
			tone: devices.policies.length > 0 ? "warn" : "neutral",
			compact: true,
		}),
		statRailItem(h, {
			eyebrow: "Critical policies failing",
			value: formatNumber(critical),
			tone: critical > 0 ? "crit" : "neutral",
			compact: true,
		}),
		statRailItem(h, {
			eyebrow: "Vulnerabilities",
			value: formatNumber(cves),
			tone: cves > 0 ? "warn" : "neutral",
			subline: "CVEs on enrolled devices",
			compact: true,
		}),
		...(scored
			? [
					statRailItem(h, {
						eyebrow: "Known exploited",
						eyebrowTooltip: "On CISA's list of vulnerabilities attackers use in the wild.",
						value: formatNumber(exploited),
						tone: exploited > 0 ? "crit" : "neutral",
						compact: true,
					}),
				]
			: []),
	])
}

const POLICY_COLUMNS = 4

const policyDetail = (h: H, policy: FleetPolicyFinding): Html =>
	vstack(h, { gap: "3", className: "px-4 py-3 sm:pl-9" }, [
		...(policy.description === null
			? []
			: [typography(h, { size: "xs", tone: "muted", as: "p" }, [policy.description])]),
		...(policy.resolution === null
			? []
			: [
					vstack(h, { gap: "1" }, [
						eyebrow(h, { variant: "label" }, ["How to fix"]),
						typography(h, { size: "xs", as: "p", className: "whitespace-pre-line" }, [
							policy.resolution,
						]),
					]),
				]),
		vstack(h, { gap: "1.5" }, [
			eyebrow(h, { variant: "label" }, [
				policy.failingHosts.length < policy.failingHostCount
					? `Failing devices, ${policy.failingHosts.length} of ${formatNumber(policy.failingHostCount)}`
					: "Failing devices",
			]),
			policy.failingHosts.length === 0
				? typography(h, { size: "xs", tone: "muted" }, ["Fleet listed none by name."])
				: hstack(
						h,
						{
							gap: "3",
							wrap: true,
							as: "ul",
							attributes: [h.AriaLabel(`Devices failing ${policy.name}`)],
						},
						Arr.map(policy.failingHosts, (device) =>
							h.li(
								[h.Key(String(device.id))],
								[
									typography(h, { size: "xs" }, [
										textLink(h, { href: device.url, attributes: external(h) }, [
											device.name,
										]),
										...(device.platform === null
											? []
											: [
													typography(h, { tone: "muted" }, [
														` ${platformLabel(device.platform)}`,
													]),
												]),
									]),
								],
							),
						),
					),
		]),
		typography(h, { size: "xs" }, [
			textLink(h, { href: policy.url, attributes: external(h) }, ["Open the policy in Fleet"]),
		]),
	])

const policyRows = (h: H, policy: FleetPolicyFinding, isExpanded: boolean): ReadonlyArray<Html> => {
	const detailId = `fleet-policy-${policy.policyId}`
	return [
		tableRow(
			h,
			[
				tableCell(
					h,
					[
						pressable(
							h,
							{
								onClick: Message.ToggledPolicy({ policyId: policy.policyId }),
								label: `${isExpanded ? "Hide" : "Show"} failing devices: ${policy.name}`,
								className:
									"focus-visible:ring-ring flex min-h-10 w-full items-center gap-2 px-2.5 py-2 text-left focus-visible:ring-1 focus-visible:outline-none focus-visible:ring-inset",
								attributes: [h.AriaExpanded(isExpanded), h.AriaControls(detailId)],
							},
							[
								expandChevron(h, isExpanded),
								vstack(h, { shrink: true }, [
									hstack(h, { gap: "2", align: "center", wrap: true }, [
										typography(h, { weight: "medium", className: "whitespace-normal" }, [
											policy.name,
										]),
										...(policy.critical
											? [badge(h, { variant: "crit", size: "sm" }, ["Critical"])]
											: []),
									]),
									// A phone has no Failing or Platform column: both ride under the name.
									typography(h, { size: "2xs", tone: "muted", className: "sm:hidden" }, [
										`${failingLabel(policy)} · ${platformLabel(policy.platform)}`,
									]),
								]),
							],
						),
					],
					"p-0 whitespace-normal",
				),
				tableCell(
					h,
					[typography(h, { size: "xs", numeric: true }, [failingLabel(policy)])],
					`${WIDE_COLUMN} whitespace-nowrap`,
				),
				tableCell(h, [typography(h, { size: "xs" }, [platformLabel(policy.platform)])], WIDE_COLUMN),
				tableCell(
					h,
					[
						typography(h, { size: "xs" }, [
							textLink(h, { href: policy.url, attributes: external(h) }, ["Open in Fleet"]),
						]),
					],
					`${WIDE_COLUMN} text-right`,
				),
			],
			isExpanded ? "bg-surface-faint" : undefined,
			[h.Key(String(policy.policyId))],
		),
		...(isExpanded
			? [
					tableRow(
						h,
						[
							tableCell(h, [policyDetail(h, policy)], "p-0 whitespace-normal", [
								h.Attribute("colspan", String(POLICY_COLUMNS)),
							]),
						],
						"bg-surface-faint hover:bg-surface-faint active:bg-surface-faint",
						[h.Key(`${policy.policyId}:detail`), h.Id(detailId)],
					),
				]
			: []),
	]
}

const quietEmpty = (h: H, title: string, description: string): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "ShieldCheckIcon")]),
				emptyTitle(h, [title]),
				emptyDescription(h, [description]),
			]),
		],
		"py-10",
	)

const policiesSection = (h: H, model: Model, policies: ReadonlyArray<FleetPolicyFinding>): Html =>
	vstack(h, { gap: "3" }, [
		sectionHeading(h, { title: "Failing policies", count: formatNumber(policies.length) }),
		panel(h, { className: "overflow-hidden" }, [
			policies.length === 0
				? quietEmpty(
						h,
						"No failing policies",
						"Every device passes every global policy on your Fleet server.",
					)
				: table(h, { ariaLabel: "Failing policies" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Policy"]),
								tableHead(h, ["Failing"], WIDE_COLUMN),
								tableHead(h, ["Platform"], WIDE_COLUMN),
								tableHead(h, [""], WIDE_COLUMN),
							]),
						]),
						tableBody(
							h,
							Arr.flatMap(policies, (policy) =>
								policyRows(h, policy, Arr.contains(model.expanded, policy.policyId)),
							),
						),
					]),
		]),
	])

const softwareLines = (h: H, vulnerability: FleetVulnerabilityFinding): Html =>
	vstack(
		h,
		{ gap: "0.5", as: "ul", attributes: [h.AriaLabel(`Software affected by ${vulnerability.cve}`)] },
		Arr.map(vulnerability.software, (software) =>
			h.li(
				[h.Key(`${software.name}@${software.version}`)],
				[
					typography(h, { size: "xs" }, [
						typography(h, { mono: true }, [softwareLabel(software)]),
						typography(h, { tone: "muted" }, [
							` · ${devicesLabel(software.hostCount)}`,
							...(software.resolvedInVersion === null
								? []
								: [` · fixed in ${software.resolvedInVersion}`]),
						]),
					]),
				],
			),
		),
	)

const vulnerabilityRow = (h: H, vulnerability: FleetVulnerabilityFinding, scored: boolean): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					vstack(h, { gap: "1", shrink: true }, [
						hstack(h, { gap: "2", align: "center", wrap: true }, [
							typography(h, { size: "xs", weight: "medium" }, [
								textLink(
									h,
									{ href: vulnerability.url, isMono: true, attributes: external(h) },
									[vulnerability.cve],
								),
							]),
							...(vulnerability.knownExploited === true
								? [badge(h, { variant: "crit", size: "sm" }, ["Known exploited"])]
								: []),
						]),
						// A phone has no Devices or Software column: the software rides under the CVE.
						h.div([h.Class("sm:hidden")], [softwareLines(h, vulnerability)]),
					]),
				],
				"whitespace-normal align-top",
			),
			...(scored
				? [
						tableCell(
							h,
							vulnerability.cvssScore === null
								? []
								: [
										vstack(h, {}, [
											typography(
												h,
												{
													size: "xs",
													weight: "medium",
													numeric: true,
													tone: SCORE_TONE[cvssTone(vulnerability.cvssScore)],
												},
												[vulnerability.cvssScore.toFixed(1)],
											),
											...(vulnerability.epssProbability === null
												? []
												: [
														typography(
															h,
															{ size: "2xs", tone: "muted", numeric: true },
															[
																`EPSS ${(vulnerability.epssProbability * 100).toFixed(1)}%`,
															],
														),
													]),
										]),
									],
							"align-top",
						),
					]
				: []),
			tableCell(
				h,
				[typography(h, { size: "xs", numeric: true }, [formatNumber(vulnerability.hostCount)])],
				`${WIDE_COLUMN} align-top`,
			),
			tableCell(h, [softwareLines(h, vulnerability)], `${WIDE_COLUMN} whitespace-normal align-top`),
		],
		undefined,
		[h.Key(vulnerability.cve)],
	)

const vulnerabilitiesSection = (h: H, connection: FleetDevicesConnection, devices: Devices): Html => {
	const { vulnerabilities, moreVulnerabilities } = devices
	const scored = hasScores(vulnerabilities)
	return vstack(h, { gap: "3" }, [
		sectionHeading(h, {
			title: "Vulnerable software",
			count: formatNumber(vulnerabilities.length + moreVulnerabilities),
		}),
		panel(h, { className: "overflow-hidden" }, [
			vulnerabilities.length === 0
				? quietEmpty(
						h,
						"No known vulnerable software",
						"Fleet reports no CVE in the software on your devices.",
					)
				: table(h, { ariaLabel: "Vulnerabilities" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["CVE"]),
								...(scored ? [tableHead(h, ["CVSS"], "w-20")] : []),
								tableHead(h, ["Devices"], `${WIDE_COLUMN} w-20`),
								tableHead(h, ["Affected software"], WIDE_COLUMN),
							]),
						]),
						tableBody(
							h,
							Arr.map(vulnerabilities, (vulnerability) =>
								vulnerabilityRow(h, vulnerability, scored),
							),
						),
					]),
		]),
		// Past the 500 listed, Fleet's own list has the rest.
		...(moreVulnerabilities > 0
			? [
					typography(h, { size: "xs", as: "p" }, [
						textLink(h, { href: fleetVulnerabilitiesHref(connection), attributes: external(h) }, [
							`+${formatNumber(moreVulnerabilities)} more in Fleet`,
						]),
					]),
				]
			: []),
		...(scored || vulnerabilities.length === 0
			? []
			: [
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"CVSS scores and known exploited flags need Fleet Premium, so CVEs are ordered by how many devices they affect.",
					]),
				]),
	])
}

const connectedBody = (
	h: H,
	model: Model,
	connection: FleetDevicesConnection,
	devices: Devices,
	clock: Clock,
): ReadonlyArray<Html> => {
	const hasSynced = connection.syncedAt !== null
	const notice = connection.authFailed
		? authFailedNotice(h, hasSynced)
		: connection.error !== null && hasSynced
			? syncErrorNotice(h, connection.error)
			: null
	if (!hasSynced)
		return [serverLine(h, connection, clock), ...(notice === null ? [firstSyncPending(h)] : [notice])]
	return [
		...(notice === null ? [] : [notice]),
		vstack(h, { gap: "3" }, [serverLine(h, connection, clock), summary(h, connection, devices)]),
		policiesSection(h, model, devices.policies),
		vulnerabilitiesSection(h, connection, devices),
	]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	const frame = (children: ReadonlyArray<Html>) =>
		securityLayout(h, { source: "devices", hasCloud: inputs.context.hasCloudSecurity === true }, children)
	const screen = screenOf(model)
	switch (screen._tag) {
		case "Loading":
			return frame([placeholderRows(h, 6)])
		case "Forbidden":
			return frame([forbidden(h)])
		case "Failed":
			return frame([
				errorState(h, {
					failure: screen.failure,
					title: "Couldn't load device findings",
					onRetry: Message.ClickedRetry(),
				}),
			])
		case "NotConnected":
			return frame([notConnected(h)])
		case "Connected":
			return frame(connectedBody(h, model, screen.connection, screen.devices, clock))
	}
})
