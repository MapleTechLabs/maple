import { OrgId } from "@maple/domain"
import { V2SourceMap } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { LinkedCursorMessage, MountLinkedZoom } from "@maple/views/charts/linked-cursor"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { describe, test } from "vitest"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const SHA = "9b2f0d1e47c6a3b90f2d8e15c4a7b6d3e09f1c28"
const OLD_SHA = "c41e7a2d9f03b8e61c7a5d2e4f9b0c13a6e8d571"
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const mounted = [
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
	Mount.resolve(MountLinkedZoom, LinkedCursorMessage.CompletedMountLinkedCursor()),
] as const

const sourceMap = (version: string, index: number, hasSources = true): V2SourceMap =>
	Schema.decodeSync(V2SourceMap)({
		object: "source_map",
		id: `6c5e2b1a-1f2e-4d3c-8b7a-01234567890${index}`,
		debug_id: null,
		service: "web",
		version,
		minified_path: `assets/chunk-${index}.js`,
		size_bytes: 1024,
		has_sources_content: hasSources,
		created_at: "2026-10-01T11:00:00.000Z",
		last_used_at: null,
	})

/** The Overview of `web` with its source maps answered, and the release commit when given. */
const withSourceMaps = (maps: ReadonlyArray<V2SourceMap>, resolvedSha?: string): Model => {
	const start = init({ serviceName: "web", search: {} }, context).model
	const resolved = pageUpdate(start, Message.CompletedResolveClock({ nowMs: NOW, mode: "Load" })).model
	const answered = pageUpdate(
		resolved,
		Message.CompletedFetchSourceMaps({
			key: resolved.sourceMaps.key ?? "",
			result: Result.succeed(maps),
		}),
	).model
	if (resolvedSha === undefined) return answered
	return pageUpdate(
		answered,
		Message.CompletedFetchCommit({
			sha: resolvedSha,
			result: Result.succeed({
				sha: resolvedSha,
				message: "ship it",
				authorName: null,
				authorLogin: "dev",
				authorAvatarUrl: null,
				committedAt: NOW,
				repoFullName: "acme/web",
				htmlUrl: `https://github.com/acme/web/commit/${resolvedSha}`,
			}),
		}),
	).model
}

describe("service detail, Source maps card", () => {
	test("a service with no source maps shows no card", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSourceMaps([])),
			...mounted,
			expectView(text("stack traces map to your code")).not.toExist(),
		)
	})

	test("the newest release's files are counted and its commit and repository link to GitHub", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSourceMaps([sourceMap(SHA, 1), sourceMap(SHA, 2), sourceMap(OLD_SHA, 3)], SHA)),
			...mounted,
			expectView(text("stack traces map to your code")).toExist(),
			expectView(text("2")).toExist(),
			expectView(text("Not yet")).toExist(),
			expectView(role("link", { name: "acme/web" })).toHaveAttr("href", "https://github.com/acme/web"),
			expectView(role("link", { name: "9b2f0d1" })).toHaveAttr(
				"href",
				`https://github.com/acme/web/commit/${SHA}`,
			),
		)
	})

	test("without a resolved commit the card shows no repository link", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSourceMaps([sourceMap(SHA, 1, false)])),
			...mounted,
			expectView(text("stack traces map to your code")).toExist(),
			expectView(role("link", { name: "acme/web" })).not.toExist(),
			expectView(
				text("Some maps carry no sources, so their frames show a file and line without code."),
			).toExist(),
		)
	})
})
