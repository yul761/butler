# Contributing to Butler

Thanks for helping. Butler is a personal productivity tool that handles other people's work data. A few rules below are non-negotiable: privacy, no network access outside the gateway, and no real `claude` or LLM calls in tests.

## Toolchain

- **Node.js.** Use the version in `.node-version` (26.3.0). `pnpm build:hook` needs it, because it builds `butler-hook` as a Node single executable with `node --build-sea` and refuses to run on a Node without that flag. Tests and the rest of the build need Node 22.13 or later (`node:sqlite`). With nvm, run `nvm install 26.3.0 && nvm use 26.3.0`. nvm doesn't read `.node-version`, but fnm does (`fnm use`).
- **pnpm.** Install pnpm 9.15.0, the version CI uses (for example `npm i -g pnpm@9.15.0`).
- **A C++ toolchain.** `pnpm install` rebuilds the native `node-pty` module for Electron.
  - macOS: Xcode Command Line Tools (`xcode-select --install`).
  - Windows: Visual Studio Build Tools with the "Desktop development with C++" workload, and Python 3.
- **Git.** On Windows you need **Git for Windows**, which provides Git Bash. Claude Code runs hooks through Git Bash, the E2E tests run the installed hook command through it, and Butler won't run git at all if `git.exe` isn't on `PATH`.

## Setup

```sh
pnpm install          # also rebuilds node-pty for Electron
pnpm build:hook       # builds build/hook/butler-hook (needed to install hooks)
pnpm dev              # runs Butler with hot reload (also builds the StateCore MCP bundle)
```

While developing, use throwaway data folders so you never touch your real `~/.butler` or `~/.claude`:

```sh
BUTLER_HOME=/tmp/butler-dev CLAUDE_CONFIG_DIR=/tmp/claude-dev pnpm dev
```

With a fresh `CLAUDE_CONFIG_DIR`, you may need to log in to `claude` once under that folder. When `BUTLER_HOME` is set, Butler also keeps Electron's own profile in `$BUTLER_HOME/electron`, so a dev instance does not collide with an installed Butler.

## Scripts

| Script | What |
|--------|------|
| `pnpm typecheck` | TypeScript for main, preload, shared, hook, memory MCP, E2E and renderer |
| `pnpm lint` | ESLint, including the egress rules |
| `pnpm test` | Vitest unit and integration tests (Node 22.13 or later) |
| `pnpm build` | Main, preload, renderer, and the StateCore MCP bundle |
| `pnpm build:hook` | The `butler-hook` executable for this platform (needs the Node in `.node-version`) |
| `pnpm e2e` | Runs `pnpm build` and `pnpm build:hook` first, then the Playwright-for-Electron tests |
| `pnpm e2e:only` | The same tests without rebuilding |
| `pnpm dist` | Unsigned installers into `dist/`, for this platform only (macOS: arm64 dmg and zip; Windows: x64 NSIS). It packages what is already built, so run `pnpm build && pnpm build:hook` first. |

The E2E tests are sandboxed. Each test gets its own temporary `BUTLER_HOME`, `CLAUDE_CONFIG_DIR`, home folder and temp folder, and uses a fake `claude` (`e2e/fake-claude`). They never run a real `claude` or read your real data.

## CI and releases

- `.github/workflows/ci.yml` runs typecheck, lint, unit tests, build, `build:hook` and the E2E tests on macOS and Windows for pull requests and pushes to `main`. Pushes to `main` also build unsigned packages.
- `.github/workflows/release.yml` runs on `v*` tags. The tag must match the `version` in `package.json`, for example `v1.0.0` for `1.0.0`. The workflow builds both platforms and creates a **draft** GitHub release. A maintainer reviews the draft and publishes it by hand.
- Nothing is pushed or released automatically. The maintainer pushes branches and tags.

### Notes for maintainers

- **Do not change `APP_ID` (`io.statecore.butler`) after the first release.** It lives in `src/main/app-id.ts` and must equal `appId` in `electron-builder.yml`, which a test enforces. Windows uses it as the AppUserModelID for notifications, Start-menu shortcuts and start-at-login.
- **Icons are generated.** The SVG sources are in `build-resources/icon-src/`; `pnpm icons` renders `build-resources/icon.png` (macOS), the multi-size `build-resources/icon.ico` (Windows; 32 px and below use the simplified tray artwork) and `src/main/tray-icons.ts`. Commit the generated files. A test checks that every icon's background contrasts with both dark and light taskbars. Don't put packaging resources in `build/`: that holds the hook and memory MCP build output.
- Builds are unsigned. macOS packages get an ad-hoc signature in `scripts/after-pack.cjs` (a fully unsigned arm64 app won't launch). The README explains how users get past Gatekeeper and SmartScreen.

## Architecture in brief

- `src/main` is the Electron main process: sessions in node-pty, hook inbox, handoff runner, scheduler, brief engine, StateCore memory and settings.
- `src/main/gateway` is the **PrivacyGateway**, the only code allowed to make network requests (the personal LLM API). ESLint enforces this in `eslint.config.mjs`, and `src/main/egress-lint.test.ts` proves the rules catch violations.
- `src/main/memory/statecore.ts` (main process) and `memory-mcp/entry.ts` (the MCP server Claude Code starts) are the only two places that may import StateCore. No StateCore process ever receives a model key: `statecoreEnv()` strips model variables, and `memory-mcp` clears them again at startup. Distillation runs only in the main process through `PrivacyGateway.statecoreModel()`, which audits and budgets each call.
- `src/renderer` is the React UI. It has no Node access and talks to main through the typed IPC whitelist in `src/shared/ipc.ts`.
- `hook/` is the tiny `butler-hook` program Claude Code runs. It must always exit 0 and never touch the network.

The design document is in `docs/superpowers/specs/` and the implementation plans are in `docs/superpowers/plans/`.

## Rules

- **No network access outside `src/main/gateway`.** Not even "just a quick fetch".
- **The privacy invariant test is a release blocker** (`src/main/gateway/privacy-invariant.test.ts`). Random ticket ids, repo names, people and terms must never appear in what is sent.
- **Tests never call a real LLM provider or the real `claude`, and never read or write the real `~/.butler` or `~/.claude`.** Use the in-process fake provider (`src/main/gateway/testing.ts`), the fake `claude` helpers (`src/main/test-utils.ts`, `e2e/fake-claude`) and temporary folders.
- **Never change the user's Claude Code configuration** from code or tests, beyond the explicit hook install the user clicks. That means no `claude mcp add`, no `claude config set` and so on. Memory MCP servers are passed per session with `--mcp-config`.
- **Database migrations are append-only** (`src/main/db/migrations.ts`).
- **User-facing text** lives in `src/renderer/src/strings.ts` (UI) and `src/main/strings.ts` (main process). The UI is Chinese. In English docs, quote UI labels exactly as they appear there and add an English gloss.
- Pin dependency versions exactly.

## Pull requests

Keep them focused, with tests. `pnpm typecheck && pnpm lint && pnpm test` must pass. Run `pnpm e2e` when you touch the UI, IPC, sessions or hooks.
