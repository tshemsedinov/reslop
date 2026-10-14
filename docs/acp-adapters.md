# ACP adapters and vendor SDKs

Checked on 2026-10-14 against the versions named below.

reslop reaches every agent over the [Agent Client Protocol](https://agentclientprotocol.com). Cursor and OpenCode serve ACP themselves. Claude Code and Codex do not, so each needs an adapter: a separate program that speaks ACP to reslop and the vendor interface to the agent. This note records which adapters reslop advises and what it would cost to drop them and talk to the vendors directly.

## What reslop advises today

| Agent       | Serves ACP              | npm package                             | Published by                           |
| ----------- | ----------------------- | --------------------------------------- | -------------------------------------- |
| Claude Code | `claude-agent-acp`      | `@agentclientprotocol/claude-agent-acp` | the ACP project (maintainers from Zed) |
| Codex       | `codex-acp`             | `@agentclientprotocol/codex-acp`        | the ACP project (maintainers from Zed) |
| OpenCode    | `opencode acp`          | `opencode-ai`                           | OpenCode, the agent itself             |
| Cursor      | `cursor-agent acp`      | none, installed from cursor.com/cli     | Cursor, the agent itself               |
| Antigravity | no ACP in the `agy` CLI | none advised                            |                                        |

The `i` key on the agents screen proposes `npm install --global` for the package of the selected row and runs it after confirmation. The install hint is drawn in the warning color. When npm exits, reslop scans PATH again in the same process: a command written into a directory already on PATH shows up immediately, and a restart would see the same PATH.

- The two adapters are not published by Anthropic or OpenAI. They come from the ACP project, are Apache-2.0, and are what ACP editors install: about 943,000 and 798,000 downloads in the week of 2026-10-06. What they wrap is the vendor's own code: `@anthropic-ai/claude-agent-sdk` 0.3.296 and `@openai/codex` 0.160.
- Both reuse the login of the installed agent and bundle their own copy of it, so the `claude` and `codex` CLIs are not required.
- `claude-agent-acp` 0.90.0 requires Node.js 22 or newer. reslop itself runs on 18.15.
- Installed together they are 114 packages and 738 MB on linux-x64. Nearly all of it is the two agent binaries (246 MB and 427 MB). None of it is a dependency of reslop.
- For Antigravity the only npm adapter found is `agy-acp` 0.5.2: one maintainer, 98 downloads in the same week, native dependencies (`node-pty`, `better-sqlite3`). It is not advised. reslop still starts `agy-acp` or `agy_acp_server.par` when one is on `PATH`.

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

`agy` has no ACP mode, no app server, and no SDK. Without an adapter the only way in is its print mode, the CLI integration that was removed.

## Conclusion

Stay with the adapters.

- One protocol and one code path serve every agent. Options A to C each add 400 to 700 lines and a second protocol to keep working per vendor.
- The adapters cost reslop no dependencies. The cost moves to the user as one global install, which the `i` key runs.
- The vendor interfaces under the adapters are a 0.x SDK, an undocumented stream, and an experimental server. Today the adapter maintainers absorb their changes.

Reasons to look again:

- A vendor ships ACP in its own CLI, as Cursor and OpenCode did. Then the agent needs one more entry in `commands` in `lib/agents/agents.js` and no adapter.
- An adapter is abandoned or falls behind its agent. Option C is the cheapest replacement for Codex, option A for Claude.
- The Node.js 22 requirement of `claude-agent-acp` becomes a problem for users of reslop on Node.js 18 or 20.
