// @maple/widgets: the unified home of what a dashboard widget *is*.
//
// Three layers, all data, no UI framework:
//
//   widget-types.ts   the closed panel-type table: which renderer, which grid
//                     size, which Perses kinds import as it, which display keys
//                     it owns
//   raw-sql-display.ts  how a raw-SQL widget renders
//   dashboard/        the versioned document schema: widgets, display, layout,
//                     sections, variables, plus the migration chain that reads
//                     older stored documents
//
// The package sits BELOW `@maple/domain` and depends on `@maple/primitives`,
// `@maple/query-model` and `effect` only. That direction is forced, not chosen: `@maple/domain` uses
// these schemas inside `MapleApi` (`http/dashboards.ts`, `http/v2/dashboards.ts`),
// so anything that owns them has to be importable by domain rather than the
// other way round.
//
// Deliberately NOT here: renderers, config panels and icons. They are web-only
// (`apps/web/src/page/dashboards/kit/`), and the native app (`apps/ios`) renders
// its own. `QueryBuilderQueryDraftSchema` is shared with alert rules, so it lives
// in `@maple/query-model`.

export * from "./raw-sql-display"
export * from "./widget-types"
export * from "./dashboard"
