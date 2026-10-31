import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type { LocalProps } from "./Local"

export interface LocalConfig {
	readonly dataDir: string
	readonly port: number
	readonly onDirtyStore: "fail" | "wipe"
}

export const localConfig = (
	props: LocalProps,
	identity: {
		readonly dotAlchemy: string
		readonly stack: string
		readonly stage: string
		readonly fqn: string
	},
): LocalConfig => {
	const key = createHash("sha256")
		.update(JSON.stringify([identity.stack, identity.stage, identity.fqn]))
		.digest("hex")
	return {
		dataDir:
			props.dataDir !== undefined
				? resolve(props.dataDir)
				: resolve(identity.dotAlchemy, "maple-local", key, "data"),
		port: props.port ?? 4318,
		onDirtyStore: props.onDirtyStore ?? "fail",
	}
}
