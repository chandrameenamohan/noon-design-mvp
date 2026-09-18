# Learning tests

Small scripts that exercise a REAL external dependency (no mocks), log what it
actually does, and assert each behavior the design assumes. Each folder is a
standalone project (its own `package.json`, outside the pnpm workspace and the
gate). Findings are at the top of each script. Re-run one when upgrading that dependency.
