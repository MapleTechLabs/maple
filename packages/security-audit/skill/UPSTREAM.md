# Vendored skill

Source: https://github.com/cloudflare/security-audit-skill (`skills/security-audit` and `LICENSE`, MIT)
Commit: c1c8a8c1471069fb0e188eeaff69b8e8db6564a8

Every file here is upstream and unmodified, except this file and the two `validate-*.d.cts`
declarations, which are Maple's. To update: copy the new upstream files over these, set the
commit above, and run `bun run --cwd packages/security-audit vendor` to regenerate
`src/skill-files.generated.ts`. `bun run test` fails while the generated module is stale and runs
the upstream validator tests unchanged.
