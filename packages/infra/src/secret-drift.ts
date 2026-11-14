// Compares what each Infisical environment holds against the catalog, by name and value
// fingerprint only. `scripts/secret-drift.ts` feeds it; nothing here sees a value.
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import type { SecretEnvironment } from "./secret.ts"
import * as Catalog from "./secrets.ts"

/** One environment's names, each with a fingerprint (a hash) of its non-blank value. */
export interface EnvironmentSnapshot {
	readonly environment: SecretEnvironment
	readonly fingerprints: ReadonlyMap<string, string>
}

export type SecretDrift =
	/** Held where the catalog keeps it out. A deploy there fails. */
	| { readonly kind: "misplaced"; readonly key: string; readonly environment: SecretEnvironment }
	/** dev or preview holds a prd instance's own value. */
	| {
			readonly kind: "shared"
			readonly key: string
			readonly environment: SecretEnvironment
			readonly prdEnvironments: ReadonlyArray<SecretEnvironment>
	  }
	/** Allowed on both prd instances, held by one. */
	| { readonly kind: "uneven"; readonly key: string; readonly heldBy: SecretEnvironment }
	/** Held, but neither catalogued nor read anywhere in the repo. */
	| {
			readonly kind: "unread"
			readonly key: string
			readonly environments: ReadonlyArray<SecretEnvironment>
	  }

const PRD: ReadonlyArray<SecretEnvironment> = ["prod", "prod-eu"]
const NON_PRD = ["dev", "preview"] satisfies ReadonlyArray<"dev" | "preview">
const secrets = Rec.values(Catalog)
const catalogued = new Set<string>(Arr.map(secrets, (secret) => secret.envKey))

/**
 * Every drift across `snapshots`. `isRead` says whether the repo reads a name the catalog lacks
 * (deploy tooling, plain config, the chat connectors' keys).
 */
export const secretDrift = (
	snapshots: ReadonlyArray<EnvironmentSnapshot>,
	isRead: (key: string) => boolean,
): ReadonlyArray<SecretDrift> => {
	const holds = (environment: SecretEnvironment, key: string) =>
		Arr.findFirst(snapshots, (snapshot) => snapshot.environment === environment).pipe(
			Option.flatMapNullishOr((snapshot) => snapshot.fingerprints.get(key)),
		)

	const perSecret = Arr.flatMap(secrets, (secret): ReadonlyArray<SecretDrift> => {
		const key = secret.envKey
		const allowed = secret.meta.environments
		const misplaced = Arr.flatMap(snapshots, ({ environment }): ReadonlyArray<SecretDrift> =>
			allowed !== undefined && !allowed.includes(environment) && Option.isSome(holds(environment, key))
				? [{ kind: "misplaced", key, environment }]
				: [],
		)
		const shared = Arr.flatMap(
			Arr.filter(
				NON_PRD,
				(environment) => !(secret.meta.sharesProdValueWith?.includes(environment) ?? false),
			),
			(environment: SecretEnvironment): ReadonlyArray<SecretDrift> => {
				const value = holds(environment, key)
				const prdEnvironments = Arr.filter(
					PRD,
					(prdEnvironment) =>
						Option.isSome(value) && Option.contains(holds(prdEnvironment, key), value.value),
				)
				return Arr.isReadonlyArrayNonEmpty(prdEnvironments)
					? [{ kind: "shared", key, environment, prdEnvironments }]
					: []
			},
		)
		const prdHolders = Arr.filter(PRD, (environment) => Option.isSome(holds(environment, key)))
		const uneven =
			prdHolders.length === 1 && Arr.every(PRD, (environment) => allowed?.includes(environment) ?? true)
				? Arr.map(prdHolders, (heldBy): SecretDrift => ({ kind: "uneven", key, heldBy }))
				: []
		return [...misplaced, ...shared, ...uneven]
	})

	const names: ReadonlyArray<string> = Arr.dedupe(
		Arr.flatMap(snapshots, (snapshot): ReadonlyArray<string> =>
			Arr.fromIterable(snapshot.fingerprints.keys()),
		),
	)
	const unread = Arr.flatMap(Arr.sort(names, Order.String), (key: string): ReadonlyArray<SecretDrift> =>
		catalogued.has(key) || isRead(key)
			? []
			: [
					{
						kind: "unread",
						key,
						environments: Arr.map(
							Arr.filter(snapshots, ({ fingerprints }) => fingerprints.has(key)),
							({ environment }) => environment,
						),
					},
				],
	)
	return [...perSecret, ...unread]
}
