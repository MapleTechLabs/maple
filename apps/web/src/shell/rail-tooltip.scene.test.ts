import * as Animation from "@foldkit/ui/animation"
import { OrgId } from "@maple/domain"
import { Option, Schema } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { Command, expect, given, hover, Mount, role, scene, selector, withViewInputs } from "foldkit/scene"
import { describe, test, vi } from "vitest"
import * as Tooltip from "../ui/tooltip"
import { Message } from "./message"
import { init, type Model, type ShellClerk } from "./model"
import { MeasureSidebarOverflow } from "./mounts"
import { update } from "./update"
import { frameView } from "./view"

// In Clerk mode the flagged rows (Releases, Security) still get the collapsed rail's tooltip.
vi.mock("../lib/services/common/auth-mode", () => ({ isClerkAuthEnabled: true }))

const organization = {
	id: Schema.decodeSync(OrgId)("org_parity"),
	name: "Parity",
	imageUrl: "",
	homeRegion: "us",
	isServedHere: true,
	isRegionOpen: false,
	flags: { aiAutoTriage: false, releases: true, securityAudit: true },
} as const

const clerk: ShellClerk = {
	maybeUser: Option.none(),
	maybeOrganization: Option.some(organization),
	memberships: [organization],
	customer: undefined,
}

const collapsed = (): Model => ({
	...init({ isMobile: false, theme: "dark", pinnedNamespaces: {}, dashboardFavorites: [] }),
	maybeOrgId: Option.some("org_parity"),
	isSidebarOpen: false,
})

const frame = withViewInputs(frameView, {
	currentPath: "/",
	clerk,
	breadcrumbs: [{ label: "Overview" }],
	page: () => null,
	topbarActions: () => null,
})()
const view = (model: Model, h: HtmlBuilder<Message>) => frame(model, h)

describe("collapsed rail in Clerk mode", () => {
	test("a row behind an org flag shows its title as a tooltip", () => {
		const security = role("link", { name: "Security" })
		scene(
			{ update, view },
			given(collapsed()),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
			hover(security),
			Command.resolve(Tooltip.WaitOpenDelay, Tooltip.Message.ElapsedOpenDelay({ generation: 1 })),
			Mount.resolve(Tooltip.MountTooltip, Tooltip.Message.CompletedMountTooltip()),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			expect(selector('[data-slot="tooltip-popup"]')).toHaveText("Security"),
		)
	})
})
