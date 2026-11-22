# BTL-252: README rewrite — design addendum

Date: 2026-11-21. Base: 4.0.0 (`5817d24a`). Stacked on BTL-251 (demo media).

## Goal

The first screen of `README.md` / `README.zh-CN.md` says only what Butler is. Everything else moves into `docs/`.

## First screen (agreed with the user)

1. `# Butler` and the line **Talk to one coordinator. It runs your Claude Code sessions and only pings you when it's your turn.**
2. The demo GIF, `docs/media/demo.gif` (English) / `docs/media/demo.zh-CN.gif` (Chinese), per `[contract:demo-media]`.
3. One line: download links for macOS (Apple silicon) and Windows, both to `releases/latest`; MIT; English | 简体中文.
4. Three selling points: hand over a body of work, not a prompt; answer in one place; sessions share memory.
5. One local-first line: Butler calls no model itself; data leaves only through your own `claude` and `gh` (the update check sentence comes from `[readme:253]`).
6. Quick start in three steps, then three links: How it works, Compared with running sessions side by side, Configuration.

## Where the old content goes

| Old README section | New home |
|---|---|
| Intro paragraphs, Language | `docs/how-it-works.md` → Overview, Language |
| How Butler compares | `docs/compare.md`, rewritten to answer "Claude Code's desktop app also runs sessions in parallel — what does Butler add?": it manages sessions, Butler manages the work |
| New in 3.0.0 | deleted; README links to the Releases page |
| What it does | `docs/how-it-works.md`, split into sections (Tickets and sessions, Mailbox, Epics, Questions and reports, PR progress, Global control, …) |
| What Butler does not touch, Where your data lives, StateCore memory, Privacy model, Code signing policy, Known issues | `docs/how-it-works.md` |
| Requirements, Install, First run, Uninstall | stay in README, shortened; the long Gatekeeper / SmartScreen fallbacks stay because they are what people get stuck on |
| Development, License | stay |

Nothing goes into `docs/configuration.md` this time: every leftover fits in how-it-works.

## Decisions

- **Two new doc pairs**, `docs/how-it-works.md` and `docs/compare.md`, each with a `.zh-CN.md` twin. They join `DOC_PAIRS` in `src/main/docs.test.ts`, so the existing checks (twin link, same heading outline, links resolve) cover them.
- **A first-screen test** in `docs.test.ts`: both READMEs carry the positioning line (Chinese README in Chinese), the GIF, `releases/latest`, and links to the three docs, all above the first `##` heading. The existing "unsigned build" checks (Gatekeeper, SmartScreen, `xattr`, `~/.butler`, StateCore, configuration and CONTRIBUTING links) and the installer-name check in `packaging.test.ts` keep passing.
- **Code signing.** The old section said a SignPath Foundation application was pending; it was turned down. The section now states the fact (macOS ad-hoc signed and not notarized, Windows unsigned) and keeps the privacy policy text. No promise of a date.
- **Installer sizes** are the 4.0.0 release assets (dmg and zip about 170 MB, Windows installer about 139 MB) instead of the 1.0.0 local measurement.
- **Content follows 4.0.** Labels come from `src/renderer/src/strings-en.ts` / `strings.ts`. Removed features (personal API, privacy tiers, distillation, planning sessions, ticket coordinators) appear only in the upgrade notes.
- The Chinese README quotes the Chinese UI (「轮到你」「全部工作」「新建 epic」「总控 session」) and uses the Chinese GIF.
- `CONTRIBUTING.md` / `.zh-CN.md` "Docs come in pairs" lists the new pairs.

## Stack and merges

- Media paths are the ones from `[contract:demo-media]`; the PR rebases onto BTL-251 before it opens so the files exist (the link test checks them).
- BTL-249's first-run changes and the `[readme:253]` / `[readme:254]` sentences are folded in when they land.
