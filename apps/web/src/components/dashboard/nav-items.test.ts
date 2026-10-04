import { describe, expect, it } from "vitest"
import {
	isNavItemActive,
	NAV_PREVIEW_MAX_GLYPHS,
	isPathActive,
	navGroups,
	paletteNavItems,
	matchSubItem,
	partitionInfraSubItems,
	type NavItem,
	type NavSurface,
} from "./nav-items"
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
	type OrganizationFeatureFlags,
} from "@/lib/organization-feature-flags"

function findItem(title: string, flags?: OrganizationFeatureFlags): NavItem {
	const item = navGroups(flags)
		.flatMap((group) => group.items)
		.find((candidate) => candidate.title === title)
	if (!item) throw new Error(`no nav item titled ${title}`)
	return item
}

describe("isPathActive", () => {
	it("matches a route and its descendants", () => {
		expect(isPathActive("/services", "/services")).toBe(true)
		expect(isPathActive("/services/checkout-svc", "/services")).toBe(true)
	})

	it("does not let a route claim a sibling that shares its prefix", () => {
		// The bug this replaces: a bare startsWith made /services light up on
		// /service-map, and would have on any future /services-foo route.
		expect(isPathActive("/service-map", "/services")).toBe(false)
		expect(isPathActive("/servicesomething", "/services")).toBe(false)
	})

	it("treats the root as exact", () => {
		expect(isPathActive("/", "/")).toBe(true)
		expect(isPathActive("/traces", "/")).toBe(false)
	})
})

describe("isNavItemActive", () => {
	it("keeps Explore active on every signal, not just its own href", () => {
		const explore = findItem("Explore")
		for (const path of ["/traces", "/logs", "/metrics", "/replays"]) {
			expect(isNavItemActive(path, explore)).toBe(true)
		}
		expect(isNavItemActive("/services", explore)).toBe(false)
	})

	it("keeps Explore active on a signal's detail route", () => {
		expect(isNavItemActive("/logs/abc123", findItem("Explore"))).toBe(true)
	})

	it("keeps Infrastructure active across its children", () => {
		const infra = findItem("Infrastructure")
		expect(isNavItemActive("/infra", infra)).toBe(true)
		expect(isNavItemActive("/infra/kubernetes/pods", infra)).toBe(true)
		expect(isNavItemActive("/infra/planetscale", infra)).toBe(true)
	})
})

describe("navGroups", () => {
	it("renders nine top-level rows", () => {
		const rows = navGroups().flatMap((group) => group.items)
		expect(rows.map((item) => item.title)).toEqual([
			"Overview",
			"Services",
			"Service Map",
			"Infrastructure",
			"Explore",
			"Web Analytics",
			"Dashboards",
			// "Investigations" is commented out of navGroups until the surface is ready.
			"Errors",
			"Alerts",
		])
	})

	it("reaches Web Analytics from the palette", () => {
		// The palette derives from navGroups, so the row being unconditional has to
		// mean it is typeable too — this was gated behind a rollout flag, and the
		// two surfaces went dark together.
		expect(paletteNavItems().map((entry) => entry.href)).toContain("/analytics")
	})

	it("gives every child of a previewed section an icon", () => {
		// The closed row previews its children by drawing their glyphs (see
		// `NavRow`), and draws nothing at all unless *every* child has one — so
		// dropping an icon here silently removes the preview rather than
		// rendering a gap. Runs with every flag on so the invariant also covers
		// any flagged children, not just the unconditional rows.
		for (const title of ["Explore", "Infrastructure"]) {
			const item = findItem(title, ENABLED_ORGANIZATION_FEATURE_FLAGS)
			expect(item.subItems?.length).toBeGreaterThan(0)
			expect(item.subItems?.every((sub) => sub.icon)).toBe(true)
		}
	})

	it("shows Releases only behind the releases flag", () => {
		for (const off of [undefined, DISABLED_ORGANIZATION_FEATURE_FLAGS]) {
			expect(
				navGroups(off)
					.flatMap((group) => group.items)
					.map((item) => item.href),
			).not.toContain("/releases")
			expect(paletteNavItems(off).map((entry) => entry.href)).not.toContain("/releases")
		}
		const on = navGroups(ENABLED_ORGANIZATION_FEATURE_FLAGS).flatMap((group) => group.items)
		expect(on.map((item) => item.title)).toContain("Releases")
		expect(paletteNavItems(ENABLED_ORGANIZATION_FEATURE_FLAGS).map((entry) => entry.href)).toContain(
			"/releases",
		)
	})

	it("shows Agent Sessions to every org", () => {
		for (const flags of [undefined, DISABLED_ORGANIZATION_FEATURE_FLAGS]) {
			expect(findItem("Explore", flags).subItems?.map((sub) => sub.href)).toContain("/agent-sessions")
			expect(paletteNavItems(flags).map((entry) => entry.href)).toContain("/agent-sessions")
		}
	})

	it("keeps Infrastructure at six children with six unique glyphs", () => {
		// Six is exactly NavRow's all-or-nothing preview cap, so a seventh unique
		// glyph here would drop the closed row's miniatures entirely rather than
		// truncate them. A new Kubernetes view goes in `views` (free); a new
		// child with a new glyph is not free.
		const infra = findItem("Infrastructure")
		expect(infra.subItems?.map((sub) => sub.title)).toEqual([
			"Overview",
			"Hosts",
			"Kubernetes",
			"Cloudflare",
			"PlanetScale",
			"Railway",
		])
		expect(new Set(infra.subItems?.map((sub) => sub.icon)).size).toBe(NAV_PREVIEW_MAX_GLYPHS)
	})

	it("folds the Kubernetes views behind one row that points at the section root", () => {
		const k8s = findItem("Infrastructure").subItems?.find((sub) => sub.title === "Kubernetes")
		expect(k8s?.href).toBe("/infra/kubernetes")
		expect(k8s?.views?.map((view) => view.href)).toEqual([
			"/infra/kubernetes/pods",
			"/infra/kubernetes/workloads",
			"/infra/kubernetes/nodes",
			"/infra/kubernetes/services",
		])
		// The one row lights on every view and every detail page beneath it.
		for (const path of [
			"/infra/kubernetes",
			"/infra/kubernetes/pods",
			"/infra/kubernetes/nodes/ip-10-0-0-1",
			"/infra/kubernetes/workloads/deployment/api",
			"/infra/kubernetes/services/checkout",
		]) {
			expect(isPathActive(path, k8s?.href ?? "")).toBe(true)
		}
	})
})

describe("paletteNavItems", () => {
	it("keeps every destination the sidebar folded into a section reachable by name", () => {
		const titles = paletteNavItems().map((entry) => entry.title)
		for (const title of [
			"Traces",
			"Logs",
			"Metrics",
			"Replays",
			"Hosts",
			"Containers",
			"Kubernetes",
			"Cloudflare",
			"PlanetScale",
		]) {
			expect(titles).toContain(title)
		}
	})

	it("keeps every folded Kubernetes view typeable by name", () => {
		// The sidebar shows one Kubernetes row; the palette must not. Someone who
		// types "nodes" expects to land on the nodes list, not the section root.
		const entries = paletteNavItems()
		for (const [title, href] of [
			["Kubernetes Pods", "/infra/kubernetes/pods"],
			["Kubernetes Workloads", "/infra/kubernetes/workloads"],
			["Kubernetes Nodes", "/infra/kubernetes/nodes"],
			["Kubernetes Services", "/infra/kubernetes/services"],
		]) {
			expect(entries.find((entry) => entry.title === title)?.href).toBe(href)
		}
	})

	it("points the signal entries at their own routes", () => {
		const entries = paletteNavItems()
		expect(entries.find((e) => e.title === "Logs")?.href).toBe("/logs")
		expect(entries.find((e) => e.title === "Replays")?.href).toBe("/replays")
	})

	it("emits no duplicate ids", () => {
		const ids = paletteNavItems().map((entry) => entry.id)
		expect(new Set(ids).size).toBe(ids.length)
	})
})

describe("partitionInfraSubItems", () => {
	const subItems = () => findItem("Infrastructure").subItems ?? []
	const titles = (items: ReadonlyArray<{ title: string }>) => items.map((item) => item.title)
	const present = (...surfaces: NavSurface[]) => new Set<NavSurface>(surfaces)

	it("shows every child while the org's surfaces are unknown", () => {
		const { shown, hidden } = partitionInfraSubItems(subItems(), null, "/infra")
		expect(shown).toHaveLength(6)
		expect(hidden).toEqual([])
	})

	it("shows Overview plus only the sources the org reports", () => {
		const { shown, hidden } = partitionInfraSubItems(
			subItems(),
			present("hosts", "planetscale"),
			"/infra",
		)
		expect(titles(shown)).toEqual(["Overview", "Hosts", "PlanetScale"])
		expect(titles(hidden)).toEqual(["Kubernetes", "Cloudflare", "Railway"])
	})

	// Containers is a view of Hosts, so a Docker-only org still gets the row.
	it("shows Hosts when only containers report", () => {
		const { shown } = partitionInfraSubItems(subItems(), present("containers"), "/infra")
		expect(titles(shown)).toEqual(["Overview", "Hosts"])
	})

	it("always shows the row for the current route, including a folded view", () => {
		expect(
			titles(partitionInfraSubItems(subItems(), present(), "/infra/kubernetes/nodes").shown),
		).toEqual(["Overview", "Kubernetes"])
		expect(titles(partitionInfraSubItems(subItems(), present(), "/infra/containers").shown)).toEqual([
			"Overview",
			"Hosts",
		])
	})

	it("shows Kubernetes when any of its surfaces reports", () => {
		for (const surface of ["k8sPods", "k8sNodes", "k8sWorkloads"] as const) {
			const { shown } = partitionInfraSubItems(subItems(), present(surface), "/infra")
			expect(titles(shown)).toEqual(["Overview", "Kubernetes"])
		}
	})

	it("loses nothing between the two parts", () => {
		for (const surfaces of [null, present(), present("hosts"), present("k8sPods", "cloudflare")]) {
			const { shown, hidden } = partitionInfraSubItems(subItems(), surfaces, "/infra")
			expect([...titles(shown), ...titles(hidden)].sort()).toEqual(titles(subItems()).sort())
		}
	})

	it("leaves ungated sections whole", () => {
		const explore = findItem("Explore").subItems ?? []
		const { shown, hidden } = partitionInfraSubItems(explore, present(), "/traces")
		expect(shown).toEqual([...explore])
		expect(hidden).toEqual([])
	})
})

describe("matchSubItem", () => {
	const infra = () => findItem("Infrastructure").subItems ?? []
	const row = (title: string) => {
		const found = infra().find((sub) => sub.title === title)
		if (!found) throw new Error(`no ${title} row`)
		return found
	}

	it("matches a folded view and prefers the longest href", () => {
		expect(matchSubItem("/infra/containers/web-1", row("Hosts"))).toBe("/infra/containers")
		expect(matchSubItem("/infra/hosts", row("Overview"))).toBe("/infra")
		expect(matchSubItem("/infra/hosts", row("Hosts"))).toBe("/infra/hosts")
		expect(matchSubItem("/traces", row("Hosts"))).toBeUndefined()
	})
})
