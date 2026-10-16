# ACP adapters and vendor SDKs

Checked on 2026-10-14 against the versions named below.

reslop reaches every agent over the [Agent Client Protocol](https://agentclientprotocol.com). Cursor, OpenCode, Junie, Copilot, Kiro, Cline, and Devin, the agent of Windsurf, serve ACP themselves. Google publishes a separate official ACP runtime for Antigravity. Claude Code, Codex, and Pi need adapters: separate programs that speak ACP to reslop and the vendor interface to the agent. This note records which integrations reslop advises and what it would cost to drop the adapters and talk to those vendors directly.

## What reslop advises today

| Agent       | Serves ACP           | Distribution                            | Published by                           |
| ----------- | -------------------- | --------------------------------------- | -------------------------------------- |
| Claude Code | `claude-agent-acp`   | `@agentclientprotocol/claude-agent-acp` | the ACP project (maintainers from Zed) |
| Codex       | `codex-acp`          | `@agentclientprotocol/codex-acp`        | the ACP project (maintainers from Zed) |
| OpenCode    | `opencode acp`       | `opencode-ai`                           | OpenCode, the agent itself             |
| Cursor      | `cursor-agent acp`   | installed from cursor.com/cli           | Cursor, the agent itself               |
| Antigravity | `agy_acp_server.par` | `antigravity-acp` in the ACP registry   | Google                                 |
| Junie       | `junie --acp=true`   | `@jetbrains/junie`                      | JetBrains, the agent itself            |
| Copilot     | `copilot --acp`      | `@github/copilot`                       | GitHub, the agent itself               |
| Pi          | `pi-acp`             | `pi-acp`                                | a community author (Sergii Kozak)      |
| Kiro        | `kiro-cli acp`       | install script from cli.kiro.dev        | AWS, the agent itself                  |
| Cline       | `cline --acp`        | `cline`                                 | Cline, the agent itself                |
| Windsurf    | `devin acp`          | install script from cli.devin.ai        | Cognition, the agent itself            |

The `i` key on the agents screen proposes an install for the selected row and runs it after confirmation. npm adapters use `npm install --global`. Antigravity is a platform archive from the official ACP registry; reslop validates the registry entry, downloads the archive from Google's host, checks each zip entry while extracting it, and records the command in its user data directory. A CLI that its vendor publishes only through an install script is installed by `lib/agents/script.js`: it downloads the script over https and runs it with `bash`, or with PowerShell on Windows, with `~/.local/bin` added to `PATH`. reslop looks for such a command in `~/.local/bin` as well. It also discovers an Antigravity runtime on `PATH` or installed in Zed's ACP registry directory. The install hint is drawn in the warning color.

- The two adapters are not published by Anthropic or OpenAI. They come from the ACP project, are Apache-2.0, and are what ACP editors install: about 943,000 and 798,000 downloads in the week of 2026-10-06. What they wrap is the vendor's own code: `@anthropic-ai/claude-agent-sdk` 0.3.296 and `@openai/codex` 0.160.
- Both reuse the login of the installed agent and bundle their own copy of it, so the `claude` and `codex` CLIs are not required.
- `claude-agent-acp` 0.90.0 requires Node.js 22 or newer. reslop itself runs on 18.15.
- Installed together they are 114 packages and 738 MB on linux-x64. Nearly all of it is the two agent binaries (246 MB and 427 MB). None of it is a dependency of reslop.
- The `agy` terminal client does not serve ACP. Its presence is detected so the screen can explain why another runtime is needed. Google's `antigravity-acp` 1.3.0 registry entry supplies `agy_acp_server.par` for macOS and Linux and `agy_acp_server.exe` for Windows. On Linux the registry command includes `--uid=`. The official runtime has its own sign-in.
- `@jetbrains/junie` 3110.7.0 downloads the Junie CLI from JetBrains' GitHub releases when it is installed, places a shim at `~/.local/bin/junie`, and serves ACP with `--acp=true`, the command of the `junie` registry entry. Its installer supports macOS and Linux; on Windows it prints JetBrains' PowerShell installer instead.
- `@github/copilot` 1.0.98 is the Copilot CLI itself; `copilot --acp` is the command of the `github-copilot-cli` registry entry. It uses the GitHub sign-in of the CLI.
- `pi-acp` 0.0.34 (MIT, the `pi-acp` registry entry) does not bundle Pi: it starts `pi --mode rpc` from `PATH`. reslop lists Pi only when both `pi-acp` and `pi` are found, and `i` installs whichever of `pi-acp` and `@earendil-works/pi-coding-agent` is missing. The adapter needs Node.js 22 and pi 0.81 or newer; Pi is configured separately for its model providers.
- Kiro CLI by AWS is not on npm (the `kiro-cli` package there is an unrelated placeholder) and not in the ACP registry. Its own scripts `cli.kiro.dev/install` and `cli.kiro.dev/install.ps1` put `kiro-cli` in `~/.local/bin`. reslop starts `kiro-cli acp --agent-engine=v3`: the V3 server takes model and effort as standard session config options, while the CLI v2 server used the unstable `session/set_model`. It uses the sign-in of the CLI.
- `cline` 3.0.71 (Apache-2.0) is the Cline CLI itself; `cline --acp` is the command of the `cline` registry entry.
- Windsurf has no ACP agent of its own: Cognition moved it to the Devin CLI, the Windsurf documentation for the CLI redirects to Devin's, and Devin's docs advise Devin over ACP for former Windsurf JetBrains users as Cascade is deprecated. reslop lists the row as `devin` and starts `devin acp`, the command of the `devin` registry entry. The registry archives are tar.gz on macOS and Linux, which the zip extractor of reslop does not read, so `i` runs Cognition's `cli.devin.ai/install.sh` or `static.devin.ai/cli/setup.ps1`. They put `devin` in `~/.local/bin`, and the unix script ends with an interactive `devin setup` that may fail without a terminal after the CLI is installed; sign in with `devin auth login`. A `windsurf` command on `PATH` is detected so the screen can explain what to install.

## Talking to the vendors without an adapter

The ACP side of reslop is 1,424 lines in `lib/agents` for all agents together. Every option below adds a second protocol beside it. The line counts are estimates for the subset reslop uses (open or continue a session, set model and effort, send one prompt, answer permission requests, render the updates), without tests.

| Option                                | New dependencies                                      | Lines in reslop | Interface status               |
| ------------------------------------- | ----------------------------------------------------- | --------------- | ------------------------------ |
| A. Claude through the Agent SDK       | `@anthropic-ai/claude-agent-sdk`, its binary, 3 peers | 400 to 600      | public, version 0.x            |
| B. Claude through the CLI stream-json | none                                                  | 500 to 700      | not documented for outside use |
| C. Codex through `codex app-server`   | none                                                  | 450 to 650      | marked experimental            |
| D. Codex through `@openai/codex-sdk`  | `@openai/codex-sdk`, `@openai/codex`                  | 250 to 350      | public, no approval callback   |

### A. Claude through `@anthropic-ai/claude-agent-sdk`

This is the official SDK and exactly what the adapter is built on.

- reslop would go from one dependency to the SDK (5.5 MB), a 246 MB platform binary as an optional dependency, and the peers `zod`, `@anthropic-ai/sdk`, and `@modelcontextprotocol/sdk`. Everyone who installs reslop pays for it, also those who never run Claude.
- The SDK is an ES module and reslop is CommonJS, so it is loaded with a dynamic `import()`.
- Its license is Anthropic's commercial terms, not an open source license. reslop is MIT.
- The code is a driver around `query()` with a permission callback (about 200 lines), a mapping from SDK messages to the log (about 150), model and effort listing (about 100), and session resume (about 50).
- The adapter spends about 10,000 lines on its core for the full feature set. The subset is small, but the SDK moves fast and every change would land in reslop instead of in the adapter.

### B. Claude through the `claude` CLI

`claude --print --input-format stream-json --output-format stream-json --permission-prompts host` is the channel the SDK itself uses. It needs no package at all. The control messages on it are not documented as a public interface, so this is the CLI integration reslop just removed, one level deeper and more fragile.

### C. Codex through `codex app-server`

The app server is part of the `codex` CLI, speaks JSON-RPC over stdio, and is what `codex-acp` talks to. No package is needed and `codex app-server generate-json-schema` prints the protocol.

- The protocol of codex 0.162.1 has 105 client requests, 84 server notifications, and 10 server requests. reslop would use about 6 requests (`initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `model/list`), 3 approval requests, and about 6 notifications.
- The JSON-RPC connection in `lib/agents/acp.js` can be reused. New code is the thread and turn driver (about 150 lines), the mapping of items to the log (about 200), approvals answered from the allow list (about 80), and model, effort, and sandbox settings (about 100).
- `codex app-server` is labeled experimental in its own help. The adapter pins a codex version for that reason, and reslop would have to follow each codex release instead.

### D. Codex through `@openai/codex-sdk`

The official SDK is small (80 KB) but brings the 427 MB `@openai/codex` binary as a dependency. Its README describes JSONL events exchanged with the `codex` CLI and configuration overrides, and no way to answer an approval request. The permission policy of reslop would have nothing to answer, which makes this the old CLI integration with a wrapper.

### Antigravity

`agy` has no ACP mode, so finding `agy` alone does not make the Antigravity row runnable. Google now publishes a separate proprietary ACP server in the official registry. reslop uses that server directly and keeps its `localharness_external` helper beside it. A previously installed community `agy-acp` command remains a fallback.

## Conclusion

Stay with the adapters.

- One protocol and one code path serve every agent. Options A to C each add 400 to 700 lines and a second protocol to keep working per vendor.
- The integrations cost reslop no bundled agent dependencies. The cost moves to the user as an on-demand install, which the `i` key runs.
- The vendor interfaces under the adapters are a 0.x SDK, an undocumented stream, and an experimental server. Today the adapter maintainers absorb their changes.

Reasons to look again:

- A vendor ships ACP in its own CLI, as Cursor and OpenCode did. Then the separate runtime can be replaced by one more entry in `commands` in `lib/agents/agents.js`.
- An adapter is abandoned or falls behind its agent. Option C is the cheapest replacement for Codex, option A for Claude.
- The Node.js 22 requirement of `claude-agent-acp` becomes a problem for users of reslop on Node.js 18 or 20.
