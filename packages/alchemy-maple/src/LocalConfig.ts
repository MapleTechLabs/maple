import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { Schema } from "effect"
import type { LocalProps } from "./Local"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export interface LocalConfig {
	readonly dataDir: string
	/** `undefined`: 4318, or a free port when it is taken. */
	readonly port: number | undefined
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
		.update(encodeJson([identity.stack, identity.stage, identity.fqn]))
		.digest("hex")
	return {
		dataDir:
			props.dataDir !== undefined
				? resolve(props.dataDir)
				: resolve(identity.dotAlchemy, "maple-local", key, "data"),
		port: props.port,
		onDirtyStore: props.onDirtyStore ?? "fail",
	}
}
