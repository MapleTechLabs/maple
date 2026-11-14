#!/usr/bin/env bun
/**
 * Checks each Infisical environment against the secret catalog (packages/infra/src/secrets.ts).
 *
 *   bun run secrets:drift
 *
 * Needs an Infisical login that reads dev, preview, prod and prod-eu. Values are hashed as they
 * arrive and never printed or written; the report names keys only. Exits non-zero on any drift.
 */
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { Array as Arr, Option, Order, Schema, String as Str } from "effect"
import type { SecretEnvironment } from "../packages/infra/src/secret.ts"
import {
	type EnvironmentSnapshot,
	type SecretDrift,
	secretDrift,
} from "../packages/infra/src/secret-drift.ts"

const REPO_ROOT = join(import.meta.dirname, "..")
const ENVIRONMENTS = ["dev", "preview", "prod", "prod-eu"] satisfies ReadonlyArray<SecretEnvironment>

const Export = Schema.fromJsonString(
	Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
)
const decodeExport = Schema.decodeUnknownOption(Export)

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(1)
}

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex")

/** The root folder only, as the deploys load it (`infisical export` is non-recursive). */
const snapshotOf = (environment: SecretEnvironment): EnvironmentSnapshot => {
	const result = spawnSync(
		"infisical",
		[
			"export",
			"--env",
			environment,
			"--format",
			"json",
			"--silent",
			// Shared values only: a personal override is not what a deploy loads.
			"--secret-overriding=false",
		],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		},
	)
	if (result.status !== 0) fail(`infisical export --env ${environment} failed; run \`infisical login\`.`)
	const entries = Option.getOrElse(decodeExport(result.stdout), () =>
		fail(`infisical export --env ${environment} returned an unexpected shape.`),
	)
	const held = Arr.filter(entries, ({ value }) => Str.trim(value) !== "")
	return {
		environment,
		fingerprints: new Map(Arr.map(held, ({ key, value }) => [key, fingerprint(Str.trim(value))])),
	}
}

// bun links each provider package in as a symlink, which grep follows only when named.
const ALCHEMY_SOURCES = [
	"node_modules/alchemy/src/",
	...Arr.map(
		readdirSync(join(REPO_ROOT, "node_modules/@alchemy.run")),
		(name) => `node_modules/@alchemy.run/${name}/`,
	),
]

/** Whether the repo reads `key` outside docs, examples, fixtures and tests, or alchemy does. */
const isRead = (key: string) =>
	spawnSync("grep", ["-rqw", "-e", key, ...ALCHEMY_SOURCES], { cwd: REPO_ROOT }).status === 0 ||
	spawnSync(
		"git",
		[
			"grep",
			"-q",
			"-w",
			"-e",
			key,
			"--",
			".",
			":!docs",
			":!*.md",
			":!.env.example",
			":!**/__fixtures__/**",
			":!*.test.ts",
		],
		{ cwd: REPO_ROOT },
	).status === 0

const describeDrift = (drift: SecretDrift): string => {
	switch (drift.kind) {
		case "misplaced":
			return `${drift.key}: held by ${drift.environment}, which the catalog keeps it out of (a deploy there fails)`
		case "shared":
			return `${drift.key}: ${drift.environment} holds the value of ${Arr.join(drift.prdEnvironments, " and ")}`
		case "uneven":
			return `${drift.key}: held by ${drift.heldBy} only; list the instance it belongs to in \`environments\` if that is intended`
		case "unread":
			return `${drift.key}: in ${Arr.join(drift.environments, ", ")}, but neither catalogued nor read by the repo or alchemy`
	}
}

const KIND_ORDER = ["misplaced", "shared", "uneven", "unread"] satisfies ReadonlyArray<SecretDrift["kind"]>
const drift = Arr.sortWith(
	secretDrift(Arr.map(ENVIRONMENTS, snapshotOf), isRead),
	(entry) => KIND_ORDER.indexOf(entry.kind),
	Order.Number,
)
if (Arr.isReadonlyArrayNonEmpty(drift)) {
	console.error(`✗ ${drift.length} secret drift(s) between Infisical and packages/infra/src/secrets.ts:`)
	Arr.forEach(drift, (entry) => console.error(`  - ${describeDrift(entry)}`))
	process.exit(1)
}
console.log(`✓ ${Arr.join(ENVIRONMENTS, ", ")} match the catalog.`)
