import * as AWS from "alchemy/AWS"
import type * as Output from "alchemy/Output"
import * as Redacted from "effect/Redacted"

/**
 * Secrets Manager entries under `<prefix>/<id>`, for an ECS service's `secrets`. Credentials go
 * here, not in `env`: task-definition env is readable by anyone with `ecs:DescribeTaskDefinition`.
 * Alchemy grants the execution role exactly these ARNs.
 */
export const ecsSecrets =
	(prefix: string, tags: Record<string, string>) =>
	(id: string, value: string | Output.Output<Redacted.Redacted<string>>) =>
		AWS.SecretsManager.Secret(id, {
			name: `${prefix}/${id}`,
			secretString: typeof value === "string" ? Redacted.make(value) : value,
			tags,
		})
