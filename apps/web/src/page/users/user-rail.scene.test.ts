import { expect as expectView, given, role, scene, text } from "foldkit/scene"
import type { HtmlBuilder } from "foldkit/html"
import { describe, test } from "vitest"
import { SOLO_DETAIL, SOLO_GROUP, USER_DETAIL, USERS_NOW, USERS_TIME_ZONE } from "../../lab/users-fixture"
import type { UserProfile } from "./data"
import { type UserGroupStats, userRail } from "./view-detail"

// The user page's right rail on its own: the group reads once, and a single namespace is a fact
// about the user, not a picker.

type Message = Readonly<{ _tag: "Picked"; namespace: string | null }>
type Model = Readonly<{ profile: UserProfile; stats: UserGroupStats; active?: string }>

const picked = (namespace: string | null): Message => ({ _tag: "Picked", namespace })

const update = (model: Model) => ({ model })
const railView = (model: Model, h: HtmlBuilder<Message>) =>
	userRail(
		h,
		model.profile,
		{ nowMs: USERS_NOW, timeZone: USERS_TIME_ZONE },
		{
			active: model.active ?? null,
			isPinned: false,
			onSelect: picked,
			onClearPin: picked(null),
		},
		"/users?groups=grp",
		model.stats,
	)

const ONLY_ACTIVE = "No one else in this group was active in this window"

describe("the user rail", () => {
	test("a group with no one else active says so instead of repeating the user's own numbers", () => {
		scene(
			{ update, view: railView },
			given({ profile: SOLO_DETAIL.profile, stats: SOLO_GROUP }),
			expectView(text(ONLY_ACTIVE)).toExist(),
			expectView(text("Sessions per user")).not.toExist(),
			expectView(text("Group id")).not.toExist(),
		)
	})

	test("a namespace picked on the page keeps the group's figures, which cover every namespace", () => {
		scene(
			{ update, view: railView },
			given({ profile: USER_DETAIL.profile, stats: SOLO_GROUP, active: "payments" }),
			expectView(text(ONLY_ACTIVE)).not.toExist(),
			expectView(text("Sessions per user")).toExist(),
			expectView(role("link", { name: /See the 1 user in Northwind Traders/ })).toExist(),
		)
	})

	test("a larger group shows its figures and links to its users", () => {
		scene(
			{ update, view: railView },
			given({
				profile: USER_DETAIL.profile,
				stats: { users: 4, activeToday: 1, withErrors: 2, sessions: 30, requests: 900 },
			}),
			expectView(text("Sessions per user")).toExist(),
			expectView(text("7.5")).toExist(),
			expectView(role("link", { name: /See all 4 users in Northwind Traders/ })).toHaveAttr(
				"href",
				"/users?groups=grp",
			),
		)
	})

	test("one namespace is an Identity row; several are a picker with shares", () => {
		scene(
			{ update, view: railView },
			given({ profile: SOLO_DETAIL.profile, stats: null }),
			expectView(text("Namespace")).toExist(),
			expectView(text("Namespaces")).not.toExist(),
		)
		scene(
			{ update, view: railView },
			given({ profile: USER_DETAIL.profile, stats: null }),
			expectView(text("Namespaces")).toExist(),
			expectView(role("button", { name: /payments/ })).toExist(),
		)
	})

	test("one named namespace beside an unnamespaced service keeps the picker that narrows to it", () => {
		const mixed: UserProfile = {
			...SOLO_DETAIL.profile,
			services: [...SOLO_DETAIL.profile.services, { service: "worker", namespace: "", signals: 40 }],
		}
		scene(
			{ update, view: railView },
			given({ profile: mixed, stats: null }),
			expectView(text("Namespaces")).toExist(),
			expectView(role("button", { name: /core/ })).toExist(),
		)
	})
})
