# Recording the demo media

**English** | [简体中文](demo-media.zh-CN.md)

The animation and screenshots at the top of the README are recorded from the real app, driven by Playwright. Re-record them whenever the UI changes, usually once per release.

## What it produces

Everything lands in `docs/media/`, light theme, 1280×768 window:

| File | What it shows |
| --- | --- |
| `demo.gif` | About 30 seconds: describe an epic to its coordinator → it splits the work into features and tickets → sessions start → a question shows up on **Your turn** → you answer it, open the ready PR, and it shows as merged |
| `your-turn.png` | The **Your turn** page with a question card and a ready-to-merge card |
| `epic.png` | An epic's overview, grouped by feature |
| `ticket.png` | A ticket page with its PR ready to merge |

Each file has a Chinese twin with `.zh-CN` before the extension (`demo.zh-CN.gif`, `your-turn.zh-CN.png` and so on), recorded with the Chinese UI for `README.zh-CN.md`.

## How to record

```sh
pnpm demo:record        # build, then record both languages
pnpm demo:record:only   # record again without rebuilding
```

You need macOS or Linux, and `ffmpeg` on your `PATH` (macOS: `brew install ffmpeg`). Windows is not supported: the fake `gh` the recording uses is a shell script. A run takes about a minute and a half. The Butler window opens in the background and won't take focus. Set `BUTLER_DEMO_OUT` to write the files somewhere else, for example to compare them with the committed ones first.

Recording is not part of CI. Look at the new files before you commit them.

## How it works

The recorder is `e2e/demo/record.demo.ts`, run by `playwright.demo.config.ts`. It is not a test.

- **Sandbox.** It starts Butler in the same sandbox as the e2e tests: a fake `claude`, a fake `gh`, and a temporary home and data folder. Your real `~/.butler` and `~/.claude` are never touched. The repos live under the sandbox's home, so headers show `~/code/fernleaf-notes-features/...`.
- **Demo data.** `e2e/demo/demo-data.ts` holds a made-up note-taking app, Fernleaf, building an "Offline mode" epic: two repos (`web`, `sync-api`), three features, five tickets `FERN-101` to `FERN-105`, and PR #42. Every name is fictional. Edit this file to change the story or its wording, in both languages.
- **Scripted agents.** No real Claude runs. The fake `claude` follows a script (`FAKE_CLAUDE_SCRIPT`, built by `fakeClaudeScript` in `demo-data.ts`): when a message contains a rule's text it replies, and it can play further steps such as tool calls, a long-running command or an `ask_user` question. The recorder plays the epic coordinator itself, calling `butler-sessions` (`create_feature`, `create_ticket`, `start_session`, `send_message`) over MCP.
- **Merging.** Butler has no merge button; you merge on GitHub. In the recording, **Open PR** opens nothing. The fake `gh` then reports PR #42 as merged, and Butler picks it up.
- **Animation.** Rather than a screen video, the recorder takes a screenshot about every 100 ms during the scenes it shows and skips the waits in between. `ffmpeg` then joins the frames at their real timing into a GIF. Captions and the pointer are drawn into the page only while recording. The recorder fails if a GIF is 5 MB or larger.

`pnpm test` checks the script rules, the frame timing and the fake `claude` script mode (`e2e/demo/demo.test.ts`).
