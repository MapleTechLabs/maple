import { Array as Arr, String as Str } from "effect"
import { expect, test } from "vitest"
import { walKeyPolicy } from "../../apps/ingest/alchemy/wal-key.ts"

const TASK_ROLE = "arn:aws:iam::123456789012:role/maple-ingest-ec2-task-role-prd-abc"
const DEPLOY_ROLE = "arn:aws:iam::123456789012:role/deploy"
/** Each data action and exactly who may run it. */
const DATA_ACTIONS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
	["kms:Decrypt", [TASK_ROLE, DEPLOY_ROLE]],
	["kms:GenerateDataKey", [TASK_ROLE, DEPLOY_ROLE]],
	["kms:CreateGrant", []],
	["kms:ReEncryptFrom", []],
	["kms:ReEncryptTo", []],
	["kms:Encrypt", []],
]

const policy = walKeyPolicy({ region: "us-east-1", users: [TASK_ROLE, DEPLOY_ROLE] })

/** Principals a statement names, flattened. A bare string (`"*"`) names everyone. */
const principalsOf = (principal: unknown): ReadonlyArray<string> => {
	if (typeof principal === "string") return [principal]
	if (typeof principal !== "object" || principal === null || !("AWS" in principal)) return []
	const aws = principal.AWS
	return typeof aws === "string"
		? [aws]
		: Arr.isArray(aws)
			? Arr.filter(aws, (v) => typeof v === "string")
			: []
}

/** Who the policy lets run `action`, honouring the simple `kms:*`-style wildcards it uses. */
const allowedFor = (action: string) =>
	Arr.flatMap(policy.Statement, (statement) => {
		const actions = statement.Action ?? []
		const matches = Arr.some(actions, (granted) =>
			Str.endsWith("*")(granted)
				? Str.startsWith(Str.slice(0, -1)(granted))(action)
				: granted === action,
		)
		return statement.Effect === "Allow" && matches ? principalsOf(statement.Principal) : []
	})

test.each(DATA_ACTIONS)("%s is allowed to exactly %j", (action, principals) => {
	expect([...allowedFor(action)].sort()).toEqual([...principals].sort())
})

test("the task role decrypts and makes data keys only through S3 in the key's region", () => {
	const statement = Arr.findFirst(policy.Statement, (s) => principalsOf(s.Principal).includes(TASK_ROLE))
	expect(statement._tag === "Some" ? statement.value.Condition : undefined).toEqual({
		StringEquals: { "kms:ViaService": "s3.us-east-1.amazonaws.com" },
	})
	expect(allowedFor("kms:Decrypt")).toContain(TASK_ROLE)
	expect(allowedFor("kms:GenerateDataKey")).toContain(TASK_ROLE)
})

test("the account root can still manage the key, so it cannot be orphaned", () => {
	expect(allowedFor("kms:PutKeyPolicy")).toEqual(["arn:aws:iam::123456789012:root"])
	expect(allowedFor("kms:ScheduleKeyDeletion")).toEqual(["arn:aws:iam::123456789012:root"])
})
