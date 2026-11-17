import type { AuditTrailSource, AuditTrailSourceState } from "@maple/domain/http"
import { AuditTrailProvider } from "@maple/domain/audit-trail"
import { Array as Arr, Schema } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { listRow } from "@maple/views/ui/list-row"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../route"
import { type IntegrationBrand, integrationIconPlate } from "../../kit/integration-empty"
import { relativeTime } from "../../kit/relative-time"
import { providerBrand } from "../kit/audit-brands"
import { providerLabel } from "../kit/audit-labels"
import { Message, type Model } from "./model"

// The audit log's sources: every platform that can feed it, whether it does, and the way to turn
// on the ones that do not. Answers "what is in here, and what else could be".

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

type SourceCopy = Readonly<{
	brand: IntegrationBrand
	/** What the platform's events are about. */
	sends: string
	/** What to do when the platform is connected but its audit feed is off. */
	turnOn: string
	/** What to do when the platform is not connected. */
	connect: string
}>

/** The platforms this build knows how to set up; Maple's own feed has nothing to set up. */
const COPY = {
	maple: {
		brand: providerBrand("maple"),
		sends: "Changes made in Maple, and requests it refused",
		turnOn: "",
		connect: "",
	},
	vercel: {
		brand: providerBrand("vercel"),
		sends: "Team actions: env vars, domains, members, tokens",
		turnOn: "Turn on the Audit log drain in the Vercel integration.",
		connect: "Connect a Vercel team and turn on its Audit log drain.",
	},
	gcp: {
		brand: providerBrand("gcp"),
		sends: "Admin Activity and Policy Denied audit logs",
		turnOn: "Turn on log forwarding: admin activity arrives through the log sink.",
		connect: "Connect a project or organization with log forwarding on.",
	},
	aws: {
		brand: providerBrand("aws"),
		sends: "CloudTrail management changes: IAM, keys, sign-ins, resources",
		// Holds whether the module is off or on but not granted yet: either way the stack needs it.
		turnOn: "Run the AWS connection's setup script again with the Security scan module on, so the role grants it.",
		connect: "Connect an AWS account with the Security scan module on.",
	},
} satisfies Record<AuditTrailProvider, SourceCopy>

/** A platform a newer writer added: its events still show, with nothing to set up. */
const isProvider = Schema.is(AuditTrailProvider)

const copyOf = (provider: string): SourceCopy =>
	isProvider(provider)
		? COPY[provider]
		: { brand: providerBrand(provider), sends: "Audit events", turnOn: "", connect: "" }

const STATE = {
	built_in: { label: "Built in", tone: "ok" },
	receiving: { label: "Receiving", tone: "ok" },
	waiting: { label: "No events yet", tone: "info" },
	off: { label: "Audit feed off", tone: "neutral" },
	failing: { label: "Failing", tone: "crit" },
	not_connected: { label: "Not connected", tone: "neutral" },
} as const satisfies Record<AuditTrailSourceState, { label: string; tone: string }>

const setupHref = (provider: string) => hrefOf(AppRoute.SourcesNew({ search: { integration: provider } }))

const eventCount = (events: number) => `${events.toLocaleString("en-US")} event${events === 1 ? "" : "s"}`

/** The line under the platform's name: what it sends, then how it is doing or what to do. */
const sourceMeta = (h: H, source: AuditTrailSource, windowDays: number, clock: Clock): Html => {
	const copy = copyOf(source.provider)
	const status: ReadonlyArray<Html | string> =
		source.state === "failing"
			? [source.problem ?? "The feed reports an error. Open the integration to see why."]
			: source.state === "off"
				? [copy.turnOn]
				: source.state === "not_connected"
					? [copy.connect]
					: source.lastEventAt === null
						? source.state === "waiting"
							? ["On. Events show up the next time someone acts there."]
							: [`Nothing in the last ${windowDays} days`]
						: [
								`${eventCount(source.events)} in ${windowDays} days, last `,
								relativeTime(h, { value: source.lastEventAt, ...clock }),
							]
	return vstack(h, { gap: "0.5" }, [
		typography(h, { size: "xs", tone: "muted" }, [
			source.account === null ? copy.sends : `${copy.sends} · ${source.account}`,
		]),
		typography(h, { size: "xs", tone: source.state === "failing" ? "destructive" : "muted" }, status),
	])
}

const stateMark = (h: H, state: AuditTrailSourceState): Html =>
	hstack(h, { gap: "1.5", align: "center", className: "whitespace-nowrap" }, [
		statusDot(h, { tone: STATE[state].tone }),
		// A phone has no room beside the description: there the dot shows and the label is read out.
		typography(h, { size: "xs", tone: "muted", className: "sr-only sm:not-sr-only" }, [
			STATE[state].label,
		]),
	])

/** Filters the list to the platform when it has events; otherwise opens its setup. */
const sourceAction = (h: H, source: AuditTrailSource, model: Model): Html | undefined => {
	const name = providerLabel(source.provider)
	if (source.state === "not_connected")
		return linkButton(h, { variant: "outline", size: "sm", href: setupHref(source.provider) }, [
			`Connect ${name}`,
		])
	if (source.state === "off" || source.state === "failing")
		return linkButton(h, { variant: "outline", size: "sm", href: setupHref(source.provider) }, [
			source.state === "off" ? "Turn on" : "Open integration",
		])
	if (source.events === 0 || model.search.provider === source.provider) return undefined
	return button(
		h,
		{
			variant: "ghost",
			size: "sm",
			attributes: [
				h.AriaLabel(`Show only ${name} events`),
				h.OnClick(Message.ChangedFilter({ filter: "provider", value: source.provider })),
			],
		},
		["View events"],
	)
}

const sourceRow = (h: H, source: AuditTrailSource, windowDays: number, model: Model, clock: Clock): Html => {
	const action = sourceAction(h, source, model)
	return listRow(
		h,
		{
			as: "li",
			divided: true,
			wrapMeta: true,
			leading: integrationIconPlate(h, copyOf(source.provider).brand, {
				size: 16,
				plateClassName: "size-8 rounded-md",
			}),
			title: providerLabel(source.provider),
			meta: sourceMeta(h, source, windowDays, clock),
			trailing: [stateMark(h, source.state), ...(action === undefined ? [] : [action])],
		},
		[h.Key(source.provider)],
	)
}

/** How many platforms send events, for the header: "2 of 3 sending". */
const sendingCount = (sources: ReadonlyArray<AuditTrailSource>) =>
	`${Arr.filter(sources, (source) => source.events > 0).length} of ${sources.length} sending`

/**
 * The sources panel above the list. Nothing while it loads, so the list does not jump twice; a
 * failed read says so in one line, since the list below still works without it.
 */
export const sourcesPanel = (h: H, model: Model, clock: Clock): Html | null =>
	AsyncData.matchData(model.sources.data, {
		onEmpty: () => null,
		onFailure: () =>
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"Couldn't load which platforms feed the audit log. Try again from the list below.",
			]),
		onData: ({ sources, windowDays }) =>
			panel(h, { className: "overflow-hidden" }, [
				panelHeader(h, {
					title: "Sources",
					action: typography(h, { size: "xs", tone: "muted" }, [
						`${sendingCount(sources)} · last ${windowDays} days`,
					]),
				}),
				h.ul(
					[h.AriaLabel("Audit log sources")],
					Arr.map(sources, (source) => sourceRow(h, source, windowDays, model, clock)),
				),
			]),
	})
