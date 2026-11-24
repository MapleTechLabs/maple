import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, SourceMapFileId } from "@maple/primitives"

const sourceMapFilesColumns = {
	id: PG.brand(PG.text, SourceMapFileId),
	orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
	debugId: PG.column(PG.nullable(PG.text), { name: "debug_id" }),
	serviceName: PG.column(PG.nullable(PG.text), { name: "service_name" }),
	version: PG.nullable(PG.text),
	minifiedPath: PG.column(PG.text, { name: "minified_path" }),
	sizeBytes: PG.column(PG.int4, { name: "size_bytes" }),
	hasSourcesContent: PG.column(PG.bool, { name: "has_sources_content" }),
	objectKey: PG.column(PG.text, { name: "object_key" }),
	createdAt: PG.column(PG.timestamptzMillis, { name: "created_at", defaultExpr: "now()" }),
	lastUsedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_used_at" }),
}

type SourceMapFilesColumns = PG.ColumnsOf<typeof sourceMapFilesColumns>

/**
 * Uploaded JavaScript source maps. The bytes live in R2 under `objectKey`; a row is found by debug
 * id first, else by service + version + minified path. Deleted 90 days after its last use.
 */
export const SourceMapFiles = PG.table("source_map_files", {
	columns: sourceMapFilesColumns,
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("source_map_files_org_debug_id_idx", ["orgId", "debugId"]),
		// Only maps without a debug id own a release path: builds with their own ids may share one.
		PG.uniqueIndex<SourceMapFilesColumns>(
			"source_map_files_org_release_path_idx",
			["orgId", "serviceName", "version", "minifiedPath"],
			{ where: ($) => $.debugId.isNull() },
		),
		PG.index("source_map_files_org_created_idx", ["orgId", "createdAt"]),
	],
	tenantColumn: "orgId",
})

export type SourceMapFileRow = PG.SelectRowOf<typeof SourceMapFiles>
