# sample-app — the "customer repo"

A small React app with its own design system. It stands in for a customer's codebase: the canvas
designs pages out of `src/design-system` components, generated pages land in `src/pages`, and the
sandbox runs this app with hot reload.

It is deliberately NOT part of the monorepo's pnpm workspace. It has its own lockfile and is
installed with `pnpm --ignore-workspace install`, exactly as a clone of it would be.
