import type { AdvisorySeverity } from "@maple/domain/package-advisories"
import { countLabel } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { view as comboboxView } from "@maple/views/ui/combobox-view"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { linkTabStrip, type LinkTab } from "../../kit/underline-tabs"
import { ALL_REPOSITORIES, dependenciesHref, type Digest } from "./derive"
import { Message, type Model, type Pane } from "./model"
import { advisoryDot } from "./view-repositories"

// What both scopes share: the switcher that picks the scope, and the tabs between its views.

type H = HtmlBuilder<Message>

/** A switcher item: the scope's worst open severity, its name, and how many advisories are open. */
const switcherItem = (h: H, name: string, worst: AdvisorySeverity | null, open: number): Html =>
	hstack(h, { gap: "2", className: "w-full min-w-0" }, [
		advisoryDot(h, worst),
		h.span([h.Class("min-w-0 flex-1 truncate")], [name]),
		typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [String(open)]),
	])

/**
 * The scope as a searchable combobox, riskiest repositories first, so it holds as many as are
 * connected. `detail` sits beside it.
 */
export const scopeSwitcher = (h: H, model: Model, digest: Digest, detail: ReadonlyArray<Html>): Html => {
	const byName = new Map(
		digest.repositories.map((repository) => [repository.fullName, repository.id] as const),
	)
	const itemOf = (label: string): Html => {
		const repositoryId = byName.get(label)
		return repositoryId === undefined
			? switcherItem(h, label, digest.worst, digest.open)
			: switcherItem(h, label, digest.statsOf(repositoryId).worst, digest.statsOf(repositoryId).open)
	}
	return hstack(h, { gap: "3", wrap: true }, [
		h.submodel({
			slotId: model.repositoryBox.id,
			model: model.repositoryBox,
			view: comboboxView,
			toParentMessage: (message) => Message.GotRepositoryBoxMessage({ message }),
			viewInputs: {
				items: [ALL_REPOSITORIES, ...digest.ranked.map((repository) => repository.fullName)],
				ariaLabel: "Repository",
				placeholder: `Search ${countLabel(digest.repositories.length, "repository", "repositories")}…`,
				emptyText: "No repository matches",
				size: "sm",
				highlightsSelected: true,
				className: "w-72",
				renderItem: (value) => [itemOf(value)],
				toView: ({ field, rest }) => h.div([h.Class("contents")], [field, ...rest]),
			},
		}),
		...detail,
	])
}

/** The scope's tabs; the repositories table is every repository's alone, so a scope passes null. */
export const paneTabs = (
	h: H,
	scope: string | null,
	pane: Pane,
	tabs: Readonly<{
		summary: Readonly<{ label: string; count: number }>
		repositories: number | null
		advisories: number
	}>,
): Html => {
	const tab = (key: Pane, label: string, count: number): LinkTab => ({
		key,
		href: dependenciesHref(scope, key),
		label,
		count,
		isCurrent: pane === key,
		isRouteActive: pane === key,
	})
	return linkTabStrip(h, "Dependency views", [
		tab("summary", tabs.summary.label, tabs.summary.count),
		...(tabs.repositories === null ? [] : [tab("repositories", "Repositories", tabs.repositories)]),
		tab("advisories", "Advisories", tabs.advisories),
	])
}
