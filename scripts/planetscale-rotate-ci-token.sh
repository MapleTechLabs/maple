#!/usr/bin/env bash
# Mint a replacement PlanetScale service token for CI, grant it every database
# access the repo's pscale-driven scripts use, store the pair in Infisical
# (env `dev`, the one cleanup-preview-orphans.yml and backup-restore-test.yml
# read), and verify the stored token can do what the old one could plus the
# backup reads. The previous token is left in place: nothing is revoked here.
#
#   ORG=makisuo DB=maple ./scripts/planetscale-rotate-ci-token.sh
#
# Needs: `pscale auth login` as a user who holds these accesses (you can only
# grant what you hold), and `infisical login` for the project in .infisical.json.
set -euo pipefail

ORG="${ORG:-makisuo}"
DB="${DB:-maple}"
ENV_SLUG="${ENV_SLUG:-dev}"

# Everything the repo exercises through PLANETSCALE_SERVICE_TOKEN(_ID):
#   branch create/list/show/delete .. create_branch read_branch delete_branch
#   role create/delete on branches . connect_branch delete_branch_password
#   role create/delete on main ..... connect_production_branch delete_production_branch_password
#   database show ................. read_database
#   backup list + restore ......... read_backups restore_backup restore_production_branch_backup
ACCESSES=(
	read_database
	read_branch create_branch delete_branch
	connect_branch delete_branch_password
	connect_production_branch delete_production_branch_password
	read_backups restore_backup restore_production_branch_backup
)

created=$(pscale service-token create --org "$ORG" --format json)
id=$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
token=$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
unset created
echo "✓ Created service token $id (secret length ${#token})"

failed=()
for access in "${ACCESSES[@]}"; do
	if pscale service-token add-access "$id" "$access" --database "$DB" --org "$ORG" >/dev/null 2>&1; then
		echo "  ok   $access"
	else
		echo "  FAIL $access"
		failed+=("$access")
	fi
done
# `restore_production_branch_backup` can only be delegated by an organization
# administrator, even by a user who can restore production backups themselves.
# Store the token regardless: every other access is in place, so the orphan
# sweep keeps working, and the restore drill turns green the moment an admin
# adds the missing access to this same token id.
if ((${#failed[@]})); then
	echo "⚠ Not grantable by your user: ${failed[*]}"
	echo "  An organization administrator finishes it with:"
	echo "    pscale service-token add-access $id ${failed[*]} --database $DB --org $ORG"
fi

echo "→ Storing in Infisical env $ENV_SLUG"
infisical secrets set "PLANETSCALE_SERVICE_TOKEN_ID=$id" "PLANETSCALE_SERVICE_TOKEN=$token" --env="$ENV_SLUG" >/dev/null
unset token

echo "→ Verifying the stored token"
stored=$(infisical secrets get PLANETSCALE_SERVICE_TOKEN_ID --env="$ENV_SLUG" --plain 2>/dev/null | tail -1)
[[ "$stored" == "$id" ]] || { echo "✗ Infisical holds $stored, expected $id"; exit 1; }
probe() {
	if infisical run --env="$ENV_SLUG" -- pscale "$@" --org "$ORG" --format json >/dev/null 2>&1; then
		echo "  ok   pscale $*"
	else
		echo "  FAIL pscale $*"
	fi
}
probe database show "$DB"
probe branch list "$DB"
probe backup list "$DB" main
probe role list "$DB" main
if ((${#failed[@]})); then
	echo "⚠ Stored, but incomplete until the admin command above has run. Old token untouched."
	exit 2
fi
echo "✓ Done. Old token untouched; revoke it once CI has run green on the new one."
