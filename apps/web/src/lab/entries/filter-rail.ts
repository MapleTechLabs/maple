import { OrgId } from "@maple/domain"
import { Effect, Result, Schema, Array as Arr } from "effect"
import type { PageContext } from "../../page/contract"
import { filterRail } from "../../page/kit/dashboard-page"
import { Message } from "../../page/replays/list/message"
import { Model, type ReplaysFacets } from "../../page/replays/list/model"
import { init, update } from "../../page/replays/list/update"
import { filtersRail } from "../../page/replays/list/view-filters"
import { hstack } from "@maple/views/ui/stack"
import { defineShellLab } from "../shell-lab"

// `/lab/filter-rail`: the `/replays` filter rail over a day of facets, to judge its density.

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const item = (name: string, count: number) => ({ name, count })

const FACETS: ReplaysFacets = {
	tags: [
		item("bot", 282),
		item("bounce", 257),
		item("idle", 70),
		item("glance", 27),
		item("engaged", 93),
		item("signed_in", 41),
		item("new_visitor", 388),
	],
	pages: [
		item("/", 207),
		item("/sign-in", 108),
		item("/service-map", 37),
		item("/blog/react-to-foldkit/", 30),
		item("/alerts", 18),
		...Arr.makeBy(155, (i) => item(`/docs/page-${i}`, 17 - (i % 17))),
	],
	services: [item("maple-landing", 385), item("maple-web", 299), item("maple-ios", 45)],
	browsers: [
		item("Chrome", 412),
		item("Safari", 188),
		item("Firefox", 61),
		item("Edge", 22),
		item("Arc", 14),
		item("Opera", 6),
	],
	devices: [item("desktop", 541), item("mobile", 162), item("tablet", 26)],
	countries: [
		item("US", 301),
		item("DE", 122),
		item("FR", 64),
		item("GB", 51),
		item("CA", 33),
		item("JP", 12),
	],
	groups: [],
	errorCount: 9,
	totalSessions: 729,
	liveSessions: 0,
	durationBuckets: [],
	durationP50: 18_000,
	durationP95: 240_000,
}

const window = { startTime: "2026-11-07 12:00:00", endTime: "2026-11-08 12:00:00" }
const NOW = 1_794_139_200_000 // 2026-11-08T12:00:00Z

const step = (model: Model, message: Message): Model => update(model, message, context).model

const loaded = (): Model => {
	const base = step(
		init({ search: {} }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	)
	return step(
		base,
		Message.CompletedFetchFacets({ key: base.facets.key ?? "", result: Result.succeed(FACETS) }),
	)
}

export const lab = defineShellLab("Filter rail", {
	Model,
	Message,
	Flags: Schema.Struct({}),
	flags: Effect.succeed({}),
	init: () => ({ model: loaded() }),
	// Commands (navigation, refetches) are dropped: only the rail's own state moves.
	update: (model, message) => ({ model: step(model, message) }),
	view: (model, h) =>
		hstack(h, { align: "stretch", className: "h-full min-h-0" }, [filterRail(h, filtersRail(h, model))]),
	currentPath: "/lab/filter-rail",
	breadcrumbs: [{ label: "Lab" }, { label: "Filter rail" }],
})
