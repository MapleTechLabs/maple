import type { DevicePolicyFinding, DeviceSource, DeviceVulnerabilityFinding } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { Array as Arr, Option, Record as Rec } from "effect"
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
import { linkButton } from "@maple/views/ui/button"
import {
	type IntegrationBrand,
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../../kit/integration-empty"
import { relativeTime } from "../../kit/relative-time"
import { sectionHeading } from "../../kit/section-heading"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { securityLayout, WIDE_COLUMN } from "../kit/layout"
import { placeholderRows } from "../kit/parts"
import {
	appliesToLabel,
	brandOf,
	criticalCount,
	cvssTone,
	DEVICE_SOURCE_BRANDS,
	type DeviceSourceBrand,
	deviceTotal,
	devicesLabel,
	failingLabel,
	hasScores,
	knownExploitedCount,
	moreVulnerabilitiesBySource,
	noFailingPoliciesText,
	platformLabel,
	policyKeyOf,
	screenOf,
	softwareLabel,
	sourceLabelOf,
	sourceTagOf,
	unscoredKinds,
} from "./derive"
import { type Devices, Message, type Model } from "./model"

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const external = (h: H) => [h.Target("_blank"), h.Rel("noopener noreferrer")]

const SCORE_TONE = { crit: "error", warn: "warning", neutral: "foreground" } as const

const connectButton = (h: H, brand: DeviceSourceBrand): Html =>
	linkButton(h, { href: brand.connectHref }, [
		`Connect ${brand.name}`,
		icon(h, "ArrowRightIcon", { size: 14 }),
	])

/** Not any one source's mark: the card offers every device source Maple reads. */
const DEVICES_MEDIA: IntegrationBrand = {
	icon: "LaptopIcon",
	accent: "var(--muted-foreground)",
	iconClassName: "text-foreground",
}

/** One card for every device source: a generic device mark, then a connect button per source. */
const connectCard = (h: H): Html =>
	integrationEmptyCard(h, [
		integrationEmptyMedia(h, DEVICES_MEDIA),
		integrationEmptyHint(h, [
			"Connect the tool that manages your devices. Maple reads it with a read-only token, and devices show here within a few minutes.",
		]),
		hstack(
			h,
			{ gap: "2", wrap: true, justify: "center" },
			Arr.map(Rec.values(DEVICE_SOURCE_BRANDS), (brand) => connectButton(h, brand)),
		),
	])

/** The on-ramp: what the page shows, then one connect card per device source Maple reads. */
const notConnected = (h: H): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, [
			{
				label: "Policies",
				title: "Failing device policies",
				description:
					"Each policy your devices fail, critical first, with the group of devices it applies to and the devices that fail it.",
			},
			{
				label: "Vulnerabilities",
				title: "Vulnerable software",
				description:
					"CVEs in the software installed on your devices, and the version that fixes each.",
			},
			{
				label: "Audit log",
				title: "Device admin activity",
				description: "Who changed what in your device management tool, beside Maple's own audit log.",
			},
		]),
		connectCard(h),
	])

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

const PENDING_DESCRIPTION =
	"Maple reads a source within about five minutes of connecting, then every hour. Failing policies and vulnerable software show here once the first sync is done."

const firstSyncPending = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "HistoryIcon")]),
				emptyTitle(h, ["Waiting for the first sync"]),
				emptyDescription(h, [PENDING_DESCRIPTION]),
			]),
		],
		emptyFrameClass("dashed"),
	)

/** With another source already synced, a pending one is a line, not the whole page. */
const pendingNotice = (h: H, source: DeviceSource): Html =>
	alert(h, { variant: "info", size: "sm" }, [
		icon(h, "HistoryIcon"),
		alertTitle(h, [`Waiting for the first sync of ${sourceLabelOf(source)}`]),
		alertDescription(h, [PENDING_DESCRIPTION]),
	])

/** " for Acme EU" when more than one source is connected, so a notice says which one. */
const whichSource = (source: DeviceSource, many: boolean): string =>
	many ? ` for ${sourceLabelOf(source)}` : ""

const authFailedNotice = (h: H, source: DeviceSource, many: boolean): Html => {
	const brand = brandOf(source.kind)
	return alert(h, { variant: "crit", size: "sm" }, [
		icon(h, "LockIcon"),
		alertTitle(h, [`${brand.name} rejected the saved ${brand.credential}${whichSource(source, many)}`]),
		alertDescription(h, [
			source.syncedAt !== null
				? "Syncing is paused, so what shows here is from the last sync. "
				: `Nothing syncs until a new ${brand.credential} is saved. `,
			textLink(h, { href: brand.connectHref }, [`Save a new ${brand.credential}`]),
		]),
	])
}

/** A failed sync; before any sync succeeded there is nothing older to show. */
const syncErrorNotice = (h: H, source: DeviceSource, error: string, many: boolean): Html => {
	const hasSynced = source.syncedAt !== null
	return alert(h, { variant: "warn", size: "sm" }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, [
			`${hasSynced ? "The last sync failed" : "The first sync failed"}${whichSource(source, many)}`,
		]),
		alertDescription(h, [
			hasSynced
				? `${error} Showing what the last good sync found; Maple retries on its own.`
				: `${error} Maple retries on its own.`,
		]),
	])
}

/** What went wrong with a source's sync, if anything. */
const sourceNotice = (h: H, source: DeviceSource, many: boolean): Html | null =>
	source.authFailed
		? authFailedNotice(h, source, many)
		: source.error !== null
			? syncErrorNotice(h, source, source.error, many)
			: null

/** The source's account, linking to it, its devices and how long ago it was read. */
const sourceLine = (h: H, source: DeviceSource, clock: Clock): Html =>
	hstack(h, { gap: "1.5", align: "center", wrap: true }, [
		// With no account name the brand is the link; with one, the brand leads it.
		...(source.label === null
			? []
			: [typography(h, { size: "xs", tone: "muted" }, [brandOf(source.kind).name])]),
		typography(h, { size: "xs", weight: "medium" }, [
			textLink(h, { href: source.url, tone: "inherit", attributes: external(h) }, [
				sourceLabelOf(source),
			]),
		]),
		...(source.deviceCount === null
			? []
			: [typography(h, { size: "xs", tone: "muted" }, [`· ${devicesLabel(source.deviceCount)}`])]),
		...(source.syncedAt === null
			? []
			: [
					typography(h, { size: "xs", tone: "muted" }, [
						"· ",
						relativeTime(h, { value: source.syncedAt, ...clock, prefix: "synced" }),
					]),
				]),
	])

const sourceLines = (h: H, sources: ReadonlyArray<DeviceSource>, clock: Clock): Html =>
	vstack(
		h,
		{ gap: "1" },
		Arr.map(sources, (source) =>
			h.div([h.Key(`${source.kind}:${source.connectionId}`)], [sourceLine(h, source, clock)]),
		),
	)

/** The source a finding came from, shown only when more than one is connected. */
const sourceTag = (h: H, tag: string | null): ReadonlyArray<Html> =>
	tag === null ? [] : [badge(h, { variant: "meta", size: "sm" }, [tag])]

const summary = (h: H, devices: Devices): Html => {
	const enrolled = deviceTotal(devices.sources)
	const scored = hasScores(devices.vulnerabilities)
	const critical = criticalCount(devices.policies)
	const exploited = knownExploitedCount(devices.sources)
	const cves = devices.vulnerabilities.length + devices.moreVulnerabilities
	return statRail(h, { columns: scored ? 5 : 4, className: "grid-cols-2" }, [
		statRailItem(h, {
			eyebrow: "Enrolled devices",
			value: enrolled === null ? "Not counted" : formatNumber(enrolled),
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

const POLICY_COLUMNS = 5

const policyDetail = (h: H, policy: DevicePolicyFinding): Html =>
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
				policy.failingDevices.length > 0 && policy.failingDevices.length < policy.failingDeviceCount
					? `Failing devices, ${policy.failingDevices.length} of ${formatNumber(policy.failingDeviceCount)}`
					: "Failing devices",
			]),
			// Empty when the sync sampled no names for this policy (it samples the first hundred).
			policy.failingDevices.length === 0
				? typography(h, { size: "xs", tone: "muted" }, [
						`Maple has no device names for this policy. ${brandOf(policy.source).name} lists them.`,
					])
				: hstack(
						h,
						{
							gap: "3",
							wrap: true,
							as: "ul",
							attributes: [h.AriaLabel(`Devices failing ${policy.name}`)],
						},
						Arr.map(policy.failingDevices, (device) =>
							h.li(
								[h.Key(device.id)],
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
			textLink(h, { href: policy.url, attributes: external(h) }, [
				`Open the policy in ${brandOf(policy.source).name}`,
			]),
		]),
	])

const policyRows = (
	h: H,
	policy: DevicePolicyFinding,
	isExpanded: boolean,
	tag: string | null,
): ReadonlyArray<Html> => {
	const key = policyKeyOf(policy)
	const detailId = `device-policy-${policy.connectionId}-${policy.policyId}`
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
								onClick: Message.ToggledPolicy({ key }),
								// The label replaces the row's content for a screen reader, so it carries what the row shows.
								label: Arr.join(
									[
										`${isExpanded ? "Hide" : "Show"} failing devices: ${policy.name}`,
										...(policy.critical ? ["critical"] : []),
										...(tag === null ? [] : [tag]),
										appliesToLabel(policy),
										failingLabel(policy),
										platformLabel(policy.platform),
									],
									", ",
								),
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
										...sourceTag(h, tag),
									]),
									// A phone has only the Policy column: the others ride under the name.
									typography(h, { size: "2xs", tone: "muted", className: "sm:hidden" }, [
										`${appliesToLabel(policy)} · ${failingLabel(policy)} · ${platformLabel(policy.platform)}`,
									]),
								]),
							],
						),
					],
					"p-0 whitespace-normal",
				),
				tableCell(
					h,
					[
						typography(h, { size: "xs", tone: policy.groupName === null ? "muted" : undefined }, [
							appliesToLabel(policy),
						]),
					],
					`${WIDE_COLUMN} whitespace-normal`,
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
							textLink(h, { href: policy.url, attributes: external(h) }, [
								`Open in ${brandOf(policy.source).name}`,
							]),
						]),
					],
					`${WIDE_COLUMN} text-right`,
				),
			],
			isExpanded ? "bg-surface-faint" : undefined,
			[h.Key(key)],
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
						[h.Key(`${key}:detail`), h.Id(detailId)],
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

const policiesSection = (h: H, model: Model, devices: Devices): Html => {
	const { policies, sources } = devices
	return vstack(h, { gap: "3" }, [
		sectionHeading(h, { title: "Failing policies", count: formatNumber(policies.length) }),
		panel(h, { className: "overflow-hidden" }, [
			policies.length === 0
				? quietEmpty(h, "No failing policies", noFailingPoliciesText(sources))
				: table(h, { ariaLabel: "Failing policies" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Policy"]),
								tableHead(h, ["Applies to"], WIDE_COLUMN),
								tableHead(h, ["Failing"], WIDE_COLUMN),
								tableHead(h, ["Platform"], WIDE_COLUMN),
								tableHead(h, [""], WIDE_COLUMN),
							]),
						]),
						tableBody(
							h,
							Arr.flatMap(policies, (policy) =>
								policyRows(
									h,
									policy,
									Arr.contains(model.expanded, policyKeyOf(policy)),
									sourceTagOf(sources, policy),
								),
							),
						),
					]),
		]),
	])
}

const softwareLines = (h: H, vulnerability: DeviceVulnerabilityFinding): Html =>
	vstack(
		h,
		{ gap: "0.5", as: "ul", attributes: [h.AriaLabel(`Software affected by ${vulnerability.cve}`)] },
		Arr.map(vulnerability.software, (software) =>
			h.li(
				[h.Key(`${software.packageSource ?? ""}:${software.name}@${software.version}`)],
				[
					typography(h, { size: "xs" }, [
						typography(h, { mono: true }, [softwareLabel(software)]),
						typography(h, { tone: "muted" }, [
							` · ${devicesLabel(software.deviceCount)}`,
							...(software.resolvedInVersion === null
								? []
								: [` · fixed in ${software.resolvedInVersion}`]),
						]),
					]),
				],
			),
		),
	)

const vulnerabilityRow = (
	h: H,
	vulnerability: DeviceVulnerabilityFinding,
	scored: boolean,
	tag: string | null,
): Html =>
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
							...sourceTag(h, tag),
							...(vulnerability.detailsLink === null
								? []
								: [
										typography(h, { size: "xs", tone: "muted" }, [
											textLink(
												h,
												{
													href: vulnerability.detailsLink,
													tone: "inherit",
													attributes: [
														...external(h),
														h.AriaLabel(`Details of ${vulnerability.cve}`),
													],
												},
												["Details"],
											),
										]),
									]),
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
				[typography(h, { size: "xs", numeric: true }, [formatNumber(vulnerability.deviceCount)])],
				`${WIDE_COLUMN} align-top`,
			),
			tableCell(h, [softwareLines(h, vulnerability)], `${WIDE_COLUMN} whitespace-normal align-top`),
		],
		undefined,
		[h.Key(`${vulnerability.source}:${vulnerability.connectionId}:${vulnerability.cve}`)],
	)

/** Why some or all CVEs carry no score, naming the sources that give none. */
const noScoresNote = (
	vulnerabilities: ReadonlyArray<DeviceVulnerabilityFinding>,
	scored: boolean,
): string | null => {
	const notes = Arr.map(unscoredKinds(vulnerabilities), (kind) => brandOf(kind).noScoresNote)
	if (notes.length === 0) return null
	return scored
		? `${Arr.join(notes, "; ")}, so their CVEs show no score.`
		: `${Arr.join(notes, "; ")}, so CVEs are ordered by how many devices they affect.`
}

const vulnerabilitiesSection = (h: H, devices: Devices): Html => {
	const { vulnerabilities, moreVulnerabilities, sources } = devices
	const scored = hasScores(vulnerabilities)
	const note = noScoresNote(vulnerabilities, scored)
	const more = moreVulnerabilitiesBySource(sources)
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
						"Your device sources report no CVE in the software on your devices.",
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
								vulnerabilityRow(
									h,
									vulnerability,
									scored,
									sourceTagOf(sources, vulnerability),
								),
							),
						),
					]),
		]),
		// Past the 500 listed per source, each source's own list has the rest.
		...Arr.map(more, (rest) =>
			typography(h, { size: "xs", as: "p", attributes: [h.Key(`more:${rest.key}`)] }, [
				rest.href === null
					? typography(h, { tone: "muted" }, [
							`+${formatNumber(rest.count)} more from ${rest.name} not listed`,
						])
					: textLink(h, { href: rest.href, attributes: external(h) }, [
							`+${formatNumber(rest.count)} more in ${rest.name}`,
						]),
			]),
		),
		...(note === null || vulnerabilities.length === 0
			? []
			: [typography(h, { size: "xs", tone: "muted", as: "p" }, [note])]),
	])
}

const connectedBody = (h: H, model: Model, devices: Devices, clock: Clock): ReadonlyArray<Html> => {
	const { sources } = devices
	const many = sources.length > 1
	const notices = Arr.getSomes(
		Arr.map(sources, (source) => Option.fromNullishOr(sourceNotice(h, source, many))),
	)
	// Unsynced sources with no error to show are still on their first read.
	const waiting = Arr.filter(
		sources,
		(source) => source.syncedAt === null && !source.authFailed && source.error === null,
	)
	if (!Arr.some(sources, (source) => source.syncedAt !== null))
		return [
			sourceLines(h, sources, clock),
			...notices,
			...(waiting.length > 0 ? [firstSyncPending(h)] : []),
		]
	return [
		...notices,
		...Arr.map(waiting, (source) => pendingNotice(h, source)),
		vstack(h, { gap: "3" }, [sourceLines(h, sources, clock), summary(h, devices)]),
		policiesSection(h, model, devices),
		vulnerabilitiesSection(h, devices),
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
			return frame(connectedBody(h, model, screen.devices, clock))
	}
})
