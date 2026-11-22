# BTL-252 plan: README rewrite

Design: `docs/superpowers/specs/2026-11-20-btl-252-readme-rewrite-design.md`.

1. **Tests first** (`src/main/docs.test.ts`): add `docs/how-it-works.md` and `docs/compare.md` pairs to `DOC_PAIRS`; add the first-screen test. Run `pnpm test src/main/docs.test.ts` and watch it fail.
2. **docs/how-it-works.md + .zh-CN.md**: move "What it does" and the reference sections out of the READMEs, with headings that match one to one. Re-point links (`docs/configuration.md#…` → `configuration.md#…`, `#what-it-does` → local anchors).
3. **docs/compare.md + .zh-CN.md**: the comparison, answering the desktop-app question.
4. **README.md + README.zh-CN.md**: the new first screen, short Requirements / Install / First run / Uninstall, links.
5. **CONTRIBUTING** pairs line; `docs/configuration*.md` line that points to the README for the merge coordinator now points to how-it-works.
6. `pnpm typecheck && pnpm lint && pnpm test`.
7. Rebase onto BTL-251 once it pushes; swap in the real media. Fold in BTL-249, `[readme:253]`, `[readme:254]`.
8. Opus review, fix, PR.
