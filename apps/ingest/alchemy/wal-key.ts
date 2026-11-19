import type { PolicyDocument } from "@alchemy.run/aws/IAM"

/**
 * Key administration for the account root. No `kms:CreateGrant` and no data-key or decrypt
 * actions: a grant would hand the key's use to a principal this policy does not name.
 */
const ADMIN_ACTIONS = [
	"kms:CreateAlias",
	"kms:DeleteAlias",
	"kms:UpdateAlias",
	"kms:Describe*",
	"kms:Get*",
	"kms:List*",
	"kms:Enable*",
	"kms:Disable*",
	"kms:Put*",
	"kms:Update*",
	"kms:RevokeGrant",
	"kms:RetireGrant",
	"kms:TagResource",
	"kms:UntagResource",
	"kms:ScheduleKeyDeletion",
	"kms:CancelKeyDeletion",
	"kms:RotateKeyOnDemand",
]

/** The account id in an IAM role ARN (`arn:aws:iam::<account>:role/<name>`). */
const accountOf = (roleArn: string) => roleArn.split(":")[4] ?? ""

/**
 * The WAL key's policy: `users` may encrypt and decrypt through S3 in `region`, and nobody
 * else may use the key at all. `users[0]` is the gateway's task role.
 */
export const walKeyPolicy = ({
	region,
	users,
}: {
	region: string
	users: readonly [string, ...string[]]
}): PolicyDocument => ({
	Version: "2012-10-17",
	Statement: [
		{
			Sid: "KeyAdministration",
			Effect: "Allow",
			Principal: { AWS: `arn:aws:iam::${accountOf(users[0])}:root` },
			Action: ADMIN_ACTIONS,
			Resource: "*",
		},
		{
			Sid: "WalSegmentsThroughS3",
			Effect: "Allow",
			Principal: { AWS: [...users] },
			Action: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
			Resource: "*",
			Condition: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
		},
	],
})
