import { EMPTY_VALUE, pluralize } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { cn } from "@maple/ui/lib/utils"
import { countryFlag, countryName } from "../../../components/analytics/labels"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import * as CopyButton from "../../../ui/copy-button"
import { detailRailField, detailRailGroup, detailRailRow } from "../../../ui/detail-rail"
import { icon, type IconName } from "../../../ui/icon"
import { segmentedBar } from "../../../ui/meter"
import { statFigure } from "../../../ui/stat-figure"
import { statusDot } from "../../../ui/status-dot"
import { truncatedText } from "../../../ui/truncated-text"
import { browserIconFor, deviceIconFor } from "../kit/sessions-parts"
import { recordedMarker } from "../kit/replay-window"
import { Message } from "./message"
import type { Model, ReplayDetail } from "./model"

// The rail's Session tab.
// TODO(tooltip): the identity links' and copy buttons' hover tooltips.

type H = HtmlBuilder<Message>

/** What the Session tab reads off the Model. */
export type SessionView = Pick<Model, "sessionId" | "copies">

const row = (
	h: H,
	options: Readonly<{ icon: IconName; label: string; hint?: string | undefined; title?: string }>,
	children: ReadonlyArray<Html | string>,
): Html => detailRailRow(h, { ...options, labelWidth: "102px" }, children)

const value = (h: H, text: string, options: Readonly<{ isMono?: boolean; className?: string }> = {}): Html =>
	h.span(
		[
			h.Class(
				cn(
					"text-xs text-foreground",
					options.isMono === true && "font-mono tabular-nums",
					options.className,
				),
			),
		],
		[text],
	)

/** `CopyButton iconSize={12} className="ml-1 size-5 shrink-0" toast={false}`. */
export const copy = (
	h: H,
	model: Pick<Model, "copies">,
	key: string,
	text: string,
	label: string,
	className = "ml-1 size-5 shrink-0",
): Html =>
	CopyButton.view(h, {
		model: model.copies[key] ?? CopyButton.init(),
		toParentMessage: (message) => Message.GotCopyMessage({ key, message }),
		value: text,
		label,
		iconSize: 12,
		className,
	})

const link = (h: H, href: string, text: string, className: string): Html =>
	h.a([h.Href(href), h.Class(className)], [text])

const stat = (h: H, iconName: IconName, label: string, count: number, isDanger = false): Html =>
	h.div(
		[
			h.Class(
				cn(
					"flex flex-col gap-0.5 rounded-md border border-border-subtle bg-surface-sunken px-2 py-1.5",
					isDanger && "border-severity-error/30 bg-severity-error/5",
				),
			),
		],
		[
			h.span(
				[h.Class("flex items-center gap-1 text-3xs text-muted-foreground")],
				[
					icon(h, iconName, {
						className: cn("size-3 shrink-0", isDanger && "text-severity-error"),
						attributes: [h.AriaHidden(true)],
					}),
					h.span([h.Class("truncate")], [label]),
				],
			),
			h.span(
				[
					h.Class(
						cn(
							"font-mono text-sm font-semibold tabular-nums",
							isDanger ? "text-severity-error" : "text-foreground",
						),
					),
				],
				[String(count)],
			),
		],
	)

const legend = (h: H, swatch: string, label: string, text: string): Html =>
	h.span(
		[h.Class("flex items-center gap-1.5")],
		[
			statusDot(h, { tone: "custom", className: swatch }),
			label,
			h.span([h.Class("font-mono tabular-nums text-foreground")], [text]),
		],
	)

const summary = (h: H, session: ReplayDetail): Html => {
	const total = session.durationMs
	const active = session.activeTimeMs
	const idle = session.idleTimeMs
	const share =
		total !== null && total > 0 && (active !== null || idle !== null)
			? {
					active: Math.min(100, ((active ?? 0) / total) * 100),
					idle: Math.min(100, ((idle ?? 0) / total) * 100),
				}
			: null
	const isErrored = session.errorCount > 0
	return h.section(
		[h.Class("border-b border-border-subtle px-4 py-3.5")],
		[
			statFigure(h, { value: formatSessionDuration(total), unit: "on the page" }),
			...(share === null
				? []
				: [
						segmentedBar(h, {
							segments: [
								{ key: "active", value: share.active, className: "bg-primary" },
								{ key: "idle", value: share.idle, className: "bg-foreground-faint" },
							],
							total: 100,
							className: "mt-3 h-1 gap-px bg-muted",
						}),
						h.div(
							[h.Class("mt-2 flex items-center gap-4 text-2xs text-muted-foreground")],
							[
								...(active === null
									? []
									: [legend(h, "bg-primary", "Active", formatSessionDuration(active))]),
								...(idle === null
									? []
									: [
											legend(
												h,
												"bg-foreground-faint",
												"Idle",
												formatSessionDuration(idle),
											),
										]),
							],
						),
					]),
			h.div(
				[h.Class("mt-3 grid grid-cols-3 gap-1.5")],
				[
					stat(h, "FileIcon", "Pages", session.pageViews || 1),
					stat(h, "CursorPointerIcon", "Clicks", session.clickCount),
					stat(
						h,
						"AlertWarningIcon",
						pluralize(session.errorCount, "Error"),
						session.errorCount,
						isErrored,
					),
				],
			),
		],
	)
}

const identity = (h: H, model: SessionView, session: ReplayDetail): Html | null => {
	const traits = Object.entries(parseAttributes(session.userTraits))
	const userId = session.userId ?? ""
	const { userName, userEmail, groupName, groupId } = session
	if (!userName && !userEmail && !userId && !groupName && !groupId && traits.length === 0) return null
	return detailRailGroup(h, "Identity", [
		...(userName
			? [
					row(h, { icon: "UserIcon", label: "Name", title: userName }, [
						value(h, userName, { className: "truncate" }),
					]),
				]
			: []),
		...(userEmail
			? [
					row(h, { icon: "EnvelopeIcon", label: "Email", title: userEmail }, [
						value(h, userEmail, { isMono: true, className: "truncate" }),
						copy(h, model, "email", userEmail, "Email"),
					]),
				]
			: []),
		...(userId
			? [
					row(h, { icon: "IdBadgeIcon", label: "User ID", title: userId }, [
						link(
							h,
							hrefOf(AppRoute.Replays({ search: { userId } })),
							userId,
							"truncate font-mono text-xs text-primary underline-offset-2 hover:underline",
						),
						copy(h, model, "userId", userId, "User ID"),
					]),
				]
			: []),
		...(groupName || groupId
			? [
					row(
						h,
						{
							icon: "TagIcon",
							label: "Group",
							hint: groupName && groupId ? groupId : undefined,
							title: [groupName, groupId].filter(Boolean).join(" · "),
						},
						[
							groupName
								? link(
										h,
										hrefOf(AppRoute.Replays({ search: { group: groupName } })),
										groupName,
										"truncate text-xs text-primary underline-offset-2 hover:underline",
									)
								: value(h, groupId, { isMono: true, className: "truncate" }),
						],
					),
				]
			: []),
		...(traits.length > 0
			? [
					detailRailField(h, { label: "Traits" }, [
						h.div(
							[h.Class("flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-muted-foreground")],
							traits.map(([key, text]) =>
								truncatedText(h, { text: `${key}: ${text}`, className: "max-w-full" }, [
									key,
									"=",
									h.span([h.Class("text-foreground-soft")], [text]),
								]),
							),
						),
					]),
				]
			: []),
	])
}

const envFact = (
	h: H,
	options: Readonly<{
		icon: IconName
		glyph?: string | undefined
		label: string
		value: string
		className?: string
	}>,
): Html =>
	h.span(
		[
			h.Class("flex min-w-0 items-center gap-2"),
			h.Title(`${options.label}: ${options.value || "unknown"}`),
		],
		[
			options.glyph === undefined || options.glyph === ""
				? icon(h, options.icon, {
						className: "size-3.5 shrink-0 text-muted-foreground",
						attributes: [h.AriaHidden(true)],
					})
				: h.span(
						[h.AriaHidden(true), h.Class("w-3.5 shrink-0 text-center text-sm leading-none")],
						[options.glyph],
					),
			h.span(
				[
					h.Class(
						cn(
							"min-w-0 truncate text-xs",
							options.value ? "text-foreground" : "text-muted-foreground",
							options.className,
						),
					),
				],
				[options.value || EMPTY_VALUE],
			),
		],
	)

const path = (h: H, text: string): Html =>
	h.span([h.Class("min-w-0 truncate font-mono text-xs text-foreground")], [text])

const acquisition = (h: H, session: ReplayDetail): Html | null =>
	session.entryPath || session.referrerHost || session.utmSource
		? detailRailGroup(h, "Acquisition", [
				...(session.entryPath
					? [
							row(
								h,
								{ icon: "ArrowRightFromLineIcon", label: "Entry", title: session.entryPath },
								[path(h, session.entryPath)],
							),
						]
					: []),
				...(session.exitPath
					? [
							row(h, { icon: "LogoutIcon", label: "Exit", title: session.exitPath }, [
								path(h, session.exitPath),
							]),
						]
					: []),
				row(h, { icon: "LinkIcon", label: "Referrer" }, [
					session.referrerHost
						? value(h, session.referrerHost, { isMono: true, className: "truncate" })
						: value(h, "None", { className: "text-muted-foreground" }),
				]),
				...(session.utmSource
					? [
							row(h, { icon: "PaperPlaneIcon", label: "Source" }, [
								value(h, [session.utmSource, session.utmMedium].filter(Boolean).join(" / "), {
									className: "truncate",
								}),
							]),
						]
					: []),
				...(session.utmCampaign
					? [
							row(h, { icon: "RocketIcon", label: "Campaign", title: session.utmCampaign }, [
								value(h, session.utmCampaign, { className: "truncate" }),
							]),
						]
					: []),
			])
		: null

const context = (h: H, model: SessionView, session: ReplayDetail): Html => {
	const recorded = recordedMarker(session.resourceAttributes)
	return detailRailGroup(h, "Context", [
		...(session.serviceName
			? [
					row(h, { icon: "ServerIcon", label: "Service", title: session.serviceName }, [
						value(h, session.serviceName, { isMono: true, className: "truncate" }),
						copy(h, model, "service", session.serviceName, "Service name"),
					]),
				]
			: []),
		row(h, { icon: "IdBadgeIcon", label: "Session ID", title: model.sessionId }, [
			value(h, shortId(model.sessionId, "session", { ellipsis: true }), {
				isMono: true,
				className: "truncate",
			}),
			copy(h, model, "session", model.sessionId, "Session ID"),
		]),
		...(recorded === undefined
			? []
			: [
					row(h, { icon: "EyeIcon", label: "Recording" }, [
						h.span(
							[h.Class("flex items-center gap-1.5 text-xs")],
							[
								statusDot(h, { tone: recorded ? "ok" : "neutral" }),
								h.span(
									[h.Class(recorded ? "text-foreground" : "text-muted-foreground")],
									[recorded ? "Complete" : "Not recorded"],
								),
							],
						),
					]),
				]),
		...(session.userAgent
			? [
					detailRailField(h, { label: "User agent" }, [
						h.span(
							[h.Class("break-words font-mono text-3xs leading-3.75 text-muted-foreground")],
							[session.userAgent],
						),
					]),
				]
			: []),
	])
}

/** The Session tab: the recording's numbers, then identity, visitor, acquisition, environment and context. */
export const sessionTab = (h: H, model: SessionView, session: ReplayDetail): Html =>
	h.div(
		[h.Class("min-h-0 flex-1 overflow-y-auto")],
		[
			summary(h, session),
			identity(h, model, session),
			session.visitorId
				? detailRailGroup(h, "Visitor", [
						row(h, { icon: "FingerprintIcon", label: "Visitor ID", title: session.visitorId }, [
							link(
								h,
								hrefOf(AppRoute.Replays({ search: { visitorId: session.visitorId } })),
								shortId(session.visitorId, "generic", { ellipsis: true }),
								"truncate font-mono text-xs text-primary underline-offset-2 hover:underline",
							),
						]),
						row(h, { icon: "UserIcon", label: "Visitor" }, [
							value(h, session.visitorIsNew ? "New" : "Returning"),
						]),
					])
				: null,
			acquisition(h, session),
			detailRailGroup(h, "Environment", [
				h.div(
					[h.Class("grid grid-cols-2 gap-x-3 gap-y-2 pt-0.5")],
					[
						envFact(h, {
							icon: browserIconFor(session.browserName),
							label: "Browser",
							value: session.browserName,
						}),
						envFact(h, { icon: "CubeIcon", label: "Operating system", value: session.osName }),
						envFact(h, {
							icon: deviceIconFor(session.deviceType),
							label: "Device",
							value: session.deviceType,
							className: "capitalize",
						}),
						envFact(h, {
							icon: "GlobeIcon",
							glyph: session.country ? countryFlag(session.country) : undefined,
							label: "Country",
							value: session.country ? countryName(session.country) : "",
						}),
					],
				),
			]),
			context(h, model, session),
		].filter((node): node is Html => node !== null),
	)
