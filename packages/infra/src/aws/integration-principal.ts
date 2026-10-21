/**
 * Maple's own AWS identity for the AWS integration: an IAM user that can only assume customer
 * `MapleIntegration-*` roles, and its access key. Customer stacks trust the user's ARN, so each
 * instance (and each preview) has its own. The key lives in alchemy state; rename the
 * `AccessKey` to rotate it.
 */
import { AWS_ROLE_NAME_PREFIX } from "@maple/domain/aws"
import * as AWS from "alchemy/AWS"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleStage } from "../cloudflare/stage.ts"
import type { MapleRegion } from "../region.ts"
import { resolveAwsResourceName } from "./stage.ts"

/** The env api and alerting read the identity from (`packages/backend/src/platform/Env.ts`). */
export interface MapleAwsPrincipalEnv {
	readonly MAPLE_AWS_PRINCIPAL_ARN: Output.Output<string>
	readonly MAPLE_AWS_ACCESS_KEY_ID: Output.Output<string>
	readonly MAPLE_AWS_SECRET_ACCESS_KEY: Output.Output<Redacted.Redacted<string>>
}

export interface MapleAwsPrincipalOptions {
	readonly stage: MapleStage
	readonly region: MapleRegion
}

export const createMapleAwsPrincipal = ({ stage, region }: MapleAwsPrincipalOptions) =>
	Effect.gen(function* () {
		const user = yield* AWS.IAM.User("aws-integrations-user", {
			userName: resolveAwsResourceName("integrations", stage, region),
			inlinePolicies: {
				"assume-integration-roles": {
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Action: ["sts:AssumeRole"],
							Resource: [`arn:aws:iam::*:role/${AWS_ROLE_NAME_PREFIX}*`],
						},
					],
				},
			},
			tags: { Service: "maple-aws-integration", Region: region },
		})
		const key = yield* AWS.IAM.AccessKey("aws-integrations-key", { userName: user.userName })
		const env: MapleAwsPrincipalEnv = {
			MAPLE_AWS_PRINCIPAL_ARN: user.userArn,
			MAPLE_AWS_ACCESS_KEY_ID: key.accessKeyId,
			// AWS returns the secret only when it creates the key. A blank one reads as unset at
			// runtime, so a key alchemy did not create leaves AWS unavailable rather than broken.
			MAPLE_AWS_SECRET_ACCESS_KEY: Output.map(
				key.secretAccessKey,
				(secret) => secret ?? Redacted.make(""),
			),
		}
		return env
	})
