# Contributing to Butler

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping. Butler is a personal productivity tool that handles other people's work data. A few rules below are non-negotiable: privacy, no network code of Butler's own, and no real `claude` or LLM calls in tests.

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
| `pnpm demo:record` | Records the README animation and screenshots into `docs/media/` (macOS or Linux, needs `ffmpeg`; see [Recording the demo media](docs/demo-media.md)). Not run in CI |
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
- **No network code.** Butler has no LLM API of its own (there is no PrivacyGateway any more; BTL-243 removed it). Every source file gets the egress rules in `eslint.config.mjs`. Only three app files get a narrow exception, each for what it needs: `src/main/notify/webhook.ts` (Electron `net`, to post the notification webhook), `memory-mcp/loopback-http.ts` (`createServer` only, the shared MCP's listener on 127.0.0.1) and the test-only `src/main/testing/loopback-recorder.ts` (`createServer` and `request`, on 127.0.0.1; no non-test file may import anything under `src/main/testing/`). The E2E fake `claude` (`e2e/fake-claude/fake-claude.cjs`) also keeps `node:http` to call the shared MCP; it never ships. `src/main/egress-lint.test.ts` proves the rules catch violations, including everything else in those three files.
- `src/main/memory/statecore.ts` (main process) and `memory-mcp/entry.ts` (the MCP server Claude Code starts) and `memory-mcp/hub-entry.ts` (the shared MCP hub) are the only places that may import StateCore. No StateCore process ever receives a model key: `statecoreEnv()` strips model variables, `memory-mcp` clears them again at startup, and every backend runs with `backgroundDigest: false`. Nothing distils memory; `remember(consolidate: true)` stays an event. `memory-mcp/memory-tools.ts` keeps statecore-mcp's tool text word for word plus a short list of named overrides, and `memory-mcp/hub-contract.test.ts` checks both against the real statecore-mcp.
- `src/renderer` is the React UI. It has no Node access and talks to main through the typed IPC whitelist in `src/shared/ipc.ts`.
- `hook/` is the tiny `butler-hook` program Claude Code runs. It must always exit 0 and never touch the network.

The design document is in `docs/superpowers/specs/` and the implementation plans are in `docs/superpowers/plans/`.

## Rules

- **No new network code.** Not even "just a quick fetch". Data leaves the machine only through the user's `claude`, outward actions through `gh` (each behind its own switch, audited) and the notification webhook.
- **Notifications say as little as possible.** By default a webhook message names only the event kind and a count; Question text, comment text, paths and repository names are never sent, and `src/main/notify/notifier.test.ts` checks that even the ticket key stays out unless **Include references** is on.
- **Tests never call a real LLM provider or the real `claude`, and never read or write the real `~/.butler` or `~/.claude`.** Use the loopback recorder (`src/main/testing/loopback-recorder.ts`) to prove nothing is sent, the fake `claude` helpers (`src/main/test-utils.ts`, `e2e/fake-claude`) and temporary folders.
- **Never change the user's Claude Code configuration** from code or tests, beyond the explicit hook install the user clicks. That means no `claude mcp add`, no `claude config set` and so on. Memory MCP servers are passed per session with `--mcp-config`.
- **Database migrations are append-only** (`src/main/db/migrations.ts`).
- **New behaviour is off until the user turns it on.** A user who changes no settings must see what the previous release did. Anything that writes to GitHub or another outside service goes through `ExternalActions.attempt` (`src/main/external/actions.ts`) with its own `external*` switch, off by default; every attempt is recorded in the audit log. `src/main/db/settings-defaults-3.test.ts` and `e2e/defaults.spec.ts` check this. The one exception is **Check for updates** (`updateCheckEnabled`, on by default): once a day it reads Butler's latest release through the user's own `gh`, writes nothing anywhere, skips quietly without `gh`, and records every check in the audit log; the same test pins it.
- **User-facing text** lives in `src/renderer/src/strings.ts` (Chinese UI), `src/renderer/src/strings-en.ts` (English UI) and `src/main/strings.ts` (main process, both languages). Add every new string in both languages.
- **Docs come in pairs.** `README.md`, `CONTRIBUTING.md` and `docs/configuration.md` are in English, and each has a Chinese twin with `.zh-CN.md` at the end of its name. Change both in the same pull request and keep their headings in the same order. Quote the English UI labels in the English docs and the Chinese ones in the Chinese docs, exactly as the string tables have them.
- Pin dependency versions exactly.

## Pull requests

Keep them focused, with tests. `pnpm typecheck && pnpm lint && pnpm test` must pass. Run `pnpm e2e` when you touch the UI, IPC, sessions or hooks.
