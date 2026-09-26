// Archive export tuning.
//
// Maple Local exports with one fixed set of values, `DEFAULT_ARCHIVE_TUNING`,
// and records them in every generation manifest. `resolveArchiveTuning` binds
// them to the resolved roots; tests and probes may pass explicit overrides.

/**
 * The effective tuning configuration used by one archive generation. All values
 * are validated at parse time; an unsafe or contradictory combination is
 * rejected before any export runs. `archiveDir` and `scratchRoot` are resolved
 * to absolute paths.
 */
export interface ArchiveTuning {
	/** ClickHouse Parquet writer thread count (`max_threads`). */
	readonly writerThreads: number
	/** Parquet row-group row count (`output_format_parquet_row_group_size`). */
	readonly rowGroupRows: number
	/** Maximum rows in one physical Parquet shard before splitting. */
	readonly maxShardRows: number
	/** Maximum estimated uncompressed bytes in one physical shard before splitting. */
	readonly maxShardBytes: number
	/** Target logical chunk size in bytes (a provisioning hint, not a hard limit). */
	readonly targetChunkBytes: number
	/** Minimum free-space reserve required on the archive volume before writing. */
	readonly minFreeSpaceReserve: number
	/** Resolved absolute archive root directory. */
	readonly archiveDir: string
	/** Resolved absolute scratch root for restored-checkpoint instances. */
	readonly scratchRoot: string
}

/** The fixed export tuning: the values archive create has always used when no
 * calibration config was passed. */
export const DEFAULT_ARCHIVE_TUNING = {
	writerThreads: 1,
	rowGroupRows: 10_000,
	maxShardRows: 500_000,
	maxShardBytes: 256 * 1024 * 1024,
	targetChunkBytes: 1024 * 1024 * 1024,
	minFreeSpaceReserve: 512 * 1024 * 1024,
} as const

/**
 * A partial override. Every field is optional; missing fields fall back to
 * {@link DEFAULT_ARCHIVE_TUNING}. The CLI passes only the roots.
 */
export interface ArchiveTuningOverrides {
	readonly writerThreads?: number
	readonly rowGroupRows?: number
	readonly maxShardRows?: number
	readonly maxShardBytes?: number
	readonly targetChunkBytes?: number
	readonly minFreeSpaceReserve?: number
	readonly archiveDir?: string
	readonly scratchRoot?: string
}

const isPositiveInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0

const requirePositiveInt = (value: unknown, key: string): number => {
	if (!isPositiveInt(value)) throw new Error(`archive tuning ${key} must be a positive integer`)
	return value
}

/**
 * Build an {@link ArchiveTuning} from defaults plus optional overrides, then
 * validate the combination. Rejects:
 *
 * - non-positive or non-integer numeric fields;
 * - a row group larger than the max shard (a shard could never hold one row
 *   group, which would split indefinitely);
 * - a max shard byte estimate smaller than a single row group's worst case;
 * - a free-space reserve larger than the target chunk (nothing could ever be
 *   archived under that reserve on a fresh volume of that size);
 * - a missing archive or scratch root.
 *
 * `archiveDir` and `scratchRoot` must be supplied (defaults are resolved by the
 * CLI layer from the deployment's configured paths); this parser does not
 * invent them.
 */
export const resolveArchiveTuning = (overrides: ArchiveTuningOverrides): ArchiveTuning => {
	const writerThreads = requirePositiveInt(
		overrides.writerThreads ?? DEFAULT_ARCHIVE_TUNING.writerThreads,
		"writerThreads",
	)
	const rowGroupRows = requirePositiveInt(
		overrides.rowGroupRows ?? DEFAULT_ARCHIVE_TUNING.rowGroupRows,
		"rowGroupRows",
	)
	const maxShardRows = requirePositiveInt(
		overrides.maxShardRows ?? DEFAULT_ARCHIVE_TUNING.maxShardRows,
		"maxShardRows",
	)
	const maxShardBytes = requirePositiveInt(
		overrides.maxShardBytes ?? DEFAULT_ARCHIVE_TUNING.maxShardBytes,
		"maxShardBytes",
	)
	const targetChunkBytes = requirePositiveInt(
		overrides.targetChunkBytes ?? DEFAULT_ARCHIVE_TUNING.targetChunkBytes,
		"targetChunkBytes",
	)
	const minFreeSpaceReserve = requirePositiveInt(
		overrides.minFreeSpaceReserve ?? DEFAULT_ARCHIVE_TUNING.minFreeSpaceReserve,
		"minFreeSpaceReserve",
	)
	if (!overrides.archiveDir) throw new Error("archive tuning requires an archive directory")
	if (!overrides.scratchRoot) throw new Error("archive tuning requires a scratch root")
	if (rowGroupRows > maxShardRows) {
		throw new Error("archive tuning rowGroupRows must not exceed maxShardRows")
	}
	// A single row group at the broadest type should fit within a shard's byte
	// budget; otherwise a shard of one row group could already exceed it.
	const minShardBytesForRowGroup = rowGroupRows * 1024
	if (maxShardBytes < minShardBytesForRowGroup) {
		throw new Error(
			`archive tuning maxShardBytes (${maxShardBytes}) is too small for rowGroupRows ` +
				`(${rowGroupRows}); raise maxShardBytes or lower rowGroupRows`,
		)
	}
	if (minFreeSpaceReserve >= targetChunkBytes) {
		throw new Error("archive tuning minFreeSpaceReserve must be smaller than targetChunkBytes")
	}
	if (writerThreads > 32) {
		throw new Error("archive tuning writerThreads must not exceed 32")
	}
	return {
		writerThreads,
		rowGroupRows,
		maxShardRows,
		maxShardBytes,
		targetChunkBytes,
		minFreeSpaceReserve,
		archiveDir: overrides.archiveDir,
		scratchRoot: overrides.scratchRoot,
	}
}

/** The effective tuning recorded in a manifest, so a generation is reproducible. */
export interface ArchiveTuningRecord {
	readonly writerThreads: number
	readonly rowGroupRows: number
	readonly maxShardRows: number
	readonly maxShardBytes: number
	readonly targetChunkBytes: number
	readonly minFreeSpaceReserve: number
}

export const tuningRecord = (tuning: ArchiveTuning): ArchiveTuningRecord => ({
	writerThreads: tuning.writerThreads,
	rowGroupRows: tuning.rowGroupRows,
	maxShardRows: tuning.maxShardRows,
	maxShardBytes: tuning.maxShardBytes,
	targetChunkBytes: tuning.targetChunkBytes,
	minFreeSpaceReserve: tuning.minFreeSpaceReserve,
})
