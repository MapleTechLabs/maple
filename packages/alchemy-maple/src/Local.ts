import type { AlchemyContext } from "alchemy/AlchemyContext"
import type { PropsInput } from "alchemy/Input"
import * as LocalProvider from "alchemy/Local/LocalProvider"
import * as ProviderLayer from "alchemy/Local/ProviderLayer"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import * as Effect from "effect/Effect"
import type { LocalConfig } from "./LocalConfig"

export interface LocalProps {
	/** Persistent store override. Defaults to an identity-specific directory inside `.alchemy`. */
	readonly dataDir?: string | undefined
	/**
	 * Bind exactly this loopback port, failing when it is taken, or when another
	 * session of this stack already serves the store on a different port. Unset:
	 * 4318, or any free port when 4318 is taken (another project or worktree).
	 */
	readonly port?: number | undefined
	/**
	 * A store whose sidecar was killed before closing it (OOM, `kill -9`, power
	 * loss) is refused by default. `"wipe"` discards its live data and starts
	 * fresh instead. Clean `alchemy dev` exits, including a closed terminal or a
	 * killed `alchemy dev`, always close the store first.
	 */
	readonly onDirtyStore?: "fail" | "wipe" | undefined
}

export interface LocalAttributes {
	readonly endpoint: string | undefined
	readonly dashboardUrl: string | undefined
	readonly dataDir: string | undefined
}

/** A shared, scoped Maple Local server during `alchemy dev`; unavailable on deploy. */
export type Local = Resource<"Maple.Local", LocalProps, LocalAttributes>
const LocalResource = Resource<Local>("Maple.Local")
export const Local = Object.assign(
	(id: string, props: PropsInput<LocalProps> = {}) => LocalResource(id, props),
	LocalResource,
)

export type LocalSpec = Effect.Effect<
	LocalProvider.LocalProviderSpec<Local, LocalConfig>,
	never,
	AlchemyContext
>

export const LocalProviderLive = () =>
	Provider.succeed(Local, {
		diff: () => Effect.succeed({ action: "noop" as const }),
		reconcile: () => Effect.succeed({ endpoint: undefined, dashboardUrl: undefined, dataDir: undefined }),
		delete: () => Effect.void,
		list: () => Effect.succeed([]),
	})

// Resolve the package entry rather than a source-relative filename: the sidecar
// is emitted separately and must also resolve from a bundled provider chunk.
export const LocalProviderLocal = () => {
	const sidecar = import.meta.resolve("@maple-dev/alchemy/local-sidecar")
	return LocalProvider.make(
		Local,
		sidecar,
		Effect.promise(() => import(sidecar) as Promise<{ localSpec: LocalSpec }>).pipe(
			Effect.flatMap((module) => module.localSpec),
		),
	)
}

/** Register local dev and no-op deploy providers without Maple cloud credentials. */
export const localProviders = () =>
	ProviderLayer.dual(Local, { live: LocalProviderLive, local: LocalProviderLocal })
