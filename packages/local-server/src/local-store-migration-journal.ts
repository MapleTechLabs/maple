// The coordinator-owned migration journal envelope. Deliberately independent of
// the executable module registry and its schema snapshots, so a host that only
// needs to know whether a migration is unfinished can read it without them.
import { readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import {
	decodeMigrationJournal,
	type MigrationJournalSchema,
	type MigrationPhase,
} from "./local-store-migrations/journal-schema"
import type { LocalSchemaIdentity } from "./schema-identity"
import { adoptLegacySidecars, dataDirSidecarPath } from "./store-version"

const NONTERMINAL_PHASES = new Set<MigrationPhase>([
	"planned",
	"preflight-complete",
	"target-created",
	"copying",
	"copy-verified",
	"promotion-started",
	"failed",
])

export const isMigrationIncomplete = (phase: MigrationPhase): boolean => NONTERMINAL_PHASES.has(phase)

export type MigrationJournal = typeof MigrationJournalSchema.Type

export const migrationJournalPath = (dataDir: string): string =>
	dataDirSidecarPath(dataDir, "maple-store-migration.json")

export const migrationRootPath = (dataDir: string, migrationId: string): string =>
	join(dirname(resolve(dataDir)), ".maple-migrations", migrationId)

export const migrationHistoryPath = (dataDir: string, migrationId: string): string =>
	join(migrationRootPath(dataDir, migrationId), "journal.json")

export const safeMigrationPath = (path: string, root: string, label: string): string => {
	const absolute = resolve(path)
	const relativePath = relative(resolve(root), absolute)
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		resolve(root) === absolute
	) {
		throw new Error(`${label} escapes migration root`)
	}
	return absolute
}

export const assertJournalPaths = (dataDir: string, journal: MigrationJournal): void => {
	const source = resolve(dataDir)
	if (resolve(journal.sourceDataDir) !== source)
		throw new Error("local migration journal source does not match the configured data directory")
	const root = migrationRootPath(dataDir, journal.migrationId)
	safeMigrationPath(journal.targetDataDir, root, "migration target")
	if (resolve(dirname(journal.targetDataDir)) !== resolve(join(root, "target")))
		throw new Error("local migration journal target is outside its owned target directory")
	if (
		journal.chain.length === 0 ||
		journal.currentStepIndex < 0 ||
		journal.currentStepIndex > journal.chain.length
	)
		throw new Error("local migration journal chain state is invalid")
	const final = journal.chain[journal.chain.length - 1]!
	if (
		final.to.version !== journal.targetVersion ||
		final.to.fingerprint !== journal.targetFingerprint ||
		final.to.digest !== journal.targetDigest
	)
		throw new Error("local migration journal final target does not match its chain")
}

const sameJournalIdentity = (a: LocalSchemaIdentity, b: LocalSchemaIdentity): boolean =>
	a.version === b.version && a.fingerprint === b.fingerprint && a.digest === b.digest && a.chdb === b.chdb

const assertJournalChainInvariants = (journal: MigrationJournal): void => {
	const { chain, currentStepIndex: current } = journal
	if (current < 0 || current > chain.length)
		throw new Error("migration journal currentStepIndex is invalid")
	if (
		!sameJournalIdentity(chain[0]!.from, {
			version: journal.sourceVersion,
			fingerprint: journal.sourceFingerprint,
			digest: journal.sourceDigest,
			chdb: journal.sourceChdb,
		})
	)
		throw new Error("migration journal source identity does not match its first step")
	if (
		!sameJournalIdentity(chain[chain.length - 1]!.to, {
			version: journal.targetVersion,
			fingerprint: journal.targetFingerprint,
			digest: journal.targetDigest,
			chdb: journal.targetChdb,
		})
	)
		throw new Error("migration journal target identity does not match its final step")
	for (let index = 1; index < chain.length; index += 1) {
		if (!sameJournalIdentity(chain[index - 1]!.to, chain[index]!.from))
			throw new Error(`migration journal step ${index} does not continue the previous step`)
	}
	for (let index = 0; index < current; index += 1) {
		if (chain[index]!.status !== "completed")
			throw new Error(`migration journal step ${index} precedes currentStepIndex but is not completed`)
	}
	for (let index = current + 1; index < chain.length; index += 1) {
		if (chain[index]!.status !== "pending")
			throw new Error(`migration journal step ${index} follows currentStepIndex but is not pending`)
	}
	if (current === chain.length) {
		if (chain.some((step) => step.status !== "completed"))
			throw new Error(
				"migration journal currentStepIndex reaches the end before all steps are completed",
			)
	} else {
		const currentStatus = chain[current]!.status
		const plannedStart = journal.phase === "planned" && current === 0
		if (plannedStart) {
			if (currentStatus !== "pending" && currentStatus !== "running")
				throw new Error("planned migration journal must begin with a pending or running step")
		} else if (currentStatus !== "running" && currentStatus !== "verified") {
			throw new Error("migration journal current step must be running or verified")
		}
	}
	if (journal.phase === "promotion-started" || journal.phase === "promoted") {
		if (current !== chain.length || chain.some((step) => step.status !== "completed"))
			throw new Error(`${journal.phase} migration journal must contain an entirely completed chain`)
	}
	if (
		(journal.phase === "preflight-complete" ||
			journal.phase === "target-created" ||
			journal.phase === "copying") &&
		current === chain.length
	)
		throw new Error(`${journal.phase} migration journal must still have an active current step`)
	if (journal.phase === "planned" && current !== 0)
		throw new Error("planned migration journal must have currentStepIndex zero")
	if (
		journal.phase === "failed" &&
		current === chain.length &&
		chain.some((step) => step.status !== "completed")
	)
		throw new Error("failed migration journal cannot end before all steps are completed")
}

const parseJournal = (value: unknown): MigrationJournal => {
	const journal = decodeMigrationJournal(value)
	if (journal.currentStepIndex > journal.chain.length)
		throw new Error("migration journal currentStepIndex is invalid")
	assertJournalChainInvariants(journal)
	for (const [index, step] of journal.chain.entries()) {
		if (step.status === "verified" || step.status === "completed") {
			if (step.state === undefined)
				throw new Error(
					`migration journal step ${index} is ${step.status} but has no persisted state`,
				)
			if (step.progress === undefined)
				throw new Error(
					`migration journal step ${index} is ${step.status} but has no persisted progress`,
				)
		}
	}
	return journal
}

/** Read and validate only the coordinator-owned journal envelope. This path is
 * intentionally independent of the executable module registry so target-only
 * abandonment remains available when a newer build cannot bind a historical
 * module or its persisted state is corrupt. */
export const readMigrationJournalStructure = async (dataDir: string): Promise<MigrationJournal | null> => {
	try {
		// A custom-named store may still keep its journal at the pre-sidecar path.
		adoptLegacySidecars(dataDir)
		return parseJournal(JSON.parse(await readFile(migrationJournalPath(dataDir), "utf8")) as unknown)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw new Error(
			`cannot read local migration journal: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}
