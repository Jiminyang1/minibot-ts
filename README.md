# MiniBot

[中文](README.zh-CN.md)

A personal assistant that runs on your own machine. It reads and writes files, runs commands, searches the web, remembers things about you, works on a schedule by itself, and gets things done through macOS Calendar, Reminders, Notes, and Mail.

Written in TypeScript. The engine is [pi](https://github.com/earendil-works/pi): `pi-ai` for model access and `pi-agent-core` for the agent loop. MiniBot owns sessions, compaction, approvals, memory, scheduled tasks, and the user interfaces.

The interface, system prompt, and skills are written in Chinese.

## Quick start

Requires Node.js 24 or later.

```bash
npm install
mkdir -p ~/.minibot && echo "DEEPSEEK_API_KEY=sk-..." >> ~/.minibot/.env
npm start
```

To use the `minibot` command from any directory:

```bash
npm link
```

Three entry points:

| Command | What it does |
|---|---|
| `minibot` | Terminal UI. Falls back to a line REPL when input is not a terminal, or with `--plain`. |
| `minibot-server [--port 8765]` | Web UI and HTTP/SSE API at `http://127.0.0.1:8765/`. |
| `minibot-daemon` | Scheduled tasks and heartbeat patrols; one per data directory. `install` starts it at login, `uninstall` stops that. |

Terminal UI keys: Enter sends, Esc cancels a run, Ctrl+O shows or hides the reasoning, Ctrl+C clears the input (cancels a run while one is active, exits when idle), Ctrl+D exits. Typing `/` completes commands.

## Configuration

Configuration comes from environment variables. Values in `$MINIBOT_HOME/.env` (default `~/.minibot/.env`) apply only to variables that are not already set.

| Variable | Default | Meaning |
|---|---|---|
| `MINIBOT_MODEL` | `deepseek/deepseek-v4-pro` | `provider/model` from the pi-ai model catalog |
| `DEEPSEEK_API_KEY` etc. | — | Credentials for the chosen provider; pi-ai defines the variable name |
| `MINIBOT_THINKING` | `medium` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `MINIBOT_MAX_OUTPUT_TOKENS` | `32000` | Output limit per request (capped at the model's maximum) |
| `MINIBOT_CONTEXT_WINDOW` | model catalog | Overrides the context window |
| `MINIBOT_COMPACT_THRESHOLD` | hard input limit | Compact first when a request grows past this many tokens |
| `MINIBOT_KEEP_RECENT_TOKENS` | `16000` | Recent context that compaction keeps verbatim |
| `MINIBOT_APPROVAL` | `ask` | `ask`: confirm sensitive tools first; `always`: approve them automatically |
| `MINIBOT_MAX_ITERATIONS` | `20` | Maximum model requests in one turn |
| `MINIBOT_MAX_RETRIES` | `3` | Retries when a model call fails before producing any output |
| `MINIBOT_HEARTBEAT_HOURS` | all day | Active window for heartbeats, for example `08:00-23:00`; may wrap past midnight, for example `22:00-06:00` |
| `MINIBOT_HOME` | `~/.minibot` | Data directory |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | — | Enable Langfuse tracing; `MINIBOT_LANGFUSE=0` turns it off |

Note: with Langfuse configured, the full content of every request (including memory, mail, and calendar data) is uploaded to Langfuse.

## Session commands

| Command | What it does |
|---|---|
| `/new` `/sessions` `/resume <id>` `/rename <title>` `/delete <id\|current>` | Manage sessions |
| `/compact` | Compact the current session now |
| `/memory [clear\|forget <id>]` | Show or manage long-term memory |
| `/tasks [cancel <id>]` | Show or cancel scheduled tasks |
| `/skills` `/mcp [tools [server]]` `/config` | Show skills, MCP servers, and configuration |
| `/permission [ask\|always]` | Show or switch the approval mode |

## Tools

| Tool | What it does | Approval |
|---|---|---|
| `read_file` `list_dir` `search_files` | Read the workspace | No |
| `write_file` `edit_file` | Write files; overwriting or editing an existing file needs the sha256 from the last read | Yes |
| `exec` | Run a command in the workspace with `bash -o pipefail`; 30-second timeout; dangerous commands are refused | Yes |
| `web_search` `fetch_url` | Search the public web and read page text | No |
| `read_artifact` | Page through tool output that was too large | No |
| `remember` `forget` | Long-term memory | No |
| `search_history` | Search past conversations across sessions | No |
| `read_skill` | Load a skill's instructions on demand | No |
| `schedule_task` `list_scheduled_tasks` `cancel_scheduled_task` | Scheduled tasks | To create |
| `calendar_*` `reminders_*` `notes_*` `mail_*` | macOS Calendar, Reminders, Notes, and Mail (macOS only) | To write |

File tools and commands can reach only the workspace they started in. Sessions, memory, and scheduled tasks are global and live in the data directory.

The first time a macOS tool touches an app, macOS asks for automation permission. When the app is not running, the tool opens it in the background and tries once more.

## MCP

Configure MCP servers in `$MINIBOT_HOME/mcp.json`. Their tools appear as `mcp__<server>__<tool>`. Tools from a server not marked `trusted` need approval.

```json
{
  "servers": {
    "drawio": { "command": "npx", "args": ["-y", "@drawio/mcp"], "timeoutSeconds": 60 },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" }, "trusted": true }
  }
}
```

`${VAR}` takes its value from the environment.

## Scheduled tasks and heartbeats

Ask MiniBot in plain language, for example "every morning at 8, make me a daily briefing". `minibot-daemon` runs the task unattended at that time:

- A regular task runs in a new session, and its result arrives as a macOS notification.
- A heartbeat patrols the checklist in `$MINIBOT_HOME/HEARTBEAT.md`. Every patrol starts from a clean context that carries only the note the last patrol left, so its cost does not grow over time; the full record stays in the heartbeat session. At the end of a patrol the model calls `heartbeat_respond` to decide whether to notify you and to update the note (for example, to record what it already told you, so it does not repeat itself). If the model forgets to call it, the patrol notifies you anyway, so no alert is lost.
- An empty checklist, or a time outside `MINIBOT_HEARTBEAT_HOURS`, skips the heartbeat without calling the model.
- A firing missed by less than an hour runs late; older ones are recorded as missed.
- Nobody is there to approve, so sensitive tools are always denied.

Tasks fire only while the daemon runs. On macOS, launchd starts it at login:

```bash
minibot-daemon install     # workspace defaults to $MINIBOT_HOME/workspace; set it with --workspace
minibot-daemon uninstall
```

`install` checks the configuration and the API key, writes `~/Library/LaunchAgents/local.minibot.daemon.plist`, and starts the daemon right away. Run `install` again after switching Node versions or moving the repository.

The daemon runs for months, so every failure stays contained:

- **Light on the machine:** it runs at background priority (macOS limits its CPU and disk use), with a 512 MB heap limit.
- **No restart loops:** launchd restarts it only after a failure, at most once a minute. A configuration error is not something a restart can fix: the daemon sends one notification, exits cleanly, and stays down.
- **Tasks stay independent:** a task whose expression is broken (for example, after a hand edit of `schedule.json`) is switched off on its own.
- **No hangs:** a run longer than 10 minutes is cancelled.
- **No notification floods:** a task that keeps failing notifies only on the first failure.
- **No runaway schedules:** recurring tasks fire at most every 5 minutes; an expression that would never fire is refused when the task is created.
- **Clean shutdown:** stopping the daemon cancels the running task and closes its session properly.
- **Bounded log:** past 5 MB, `daemon.log` moves to `daemon.log.1` and starts over.
- **No access to secrets:** the default workspace is `$MINIBOT_HOME/workspace`, not your home directory, so unattended runs cannot read files such as `~/.ssh` or `.env`.

## Data directory

```
~/.minibot/
  .env                         configuration
  sessions/<id>/meta.json      session title, timestamps, message count
  sessions/<id>/entries.jsonl  append-only session log (the source of truth)
  sessions/<id>/artifacts/     tool output that was too large
  current-session              id of the current session
  memory.json                  long-term memory
  schedule.json                scheduled tasks
  HEARTBEAT.md                 heartbeat checklist
  runs.jsonl                   one summary line per run
  mcp.json                     MCP server configuration
  daemon.pid / daemon.log      the running daemon and its log
  workspace/                   the daemon's default workspace
  evals/                       local eval results
```

## Evals

`evals/cases.json` is the golden case set. Each case runs one turn with the real model in a sandbox (a temporary data directory and workspace, with stand-ins for the macOS, command, and web tools) and is scored in six stages: skill selection, tool selection, tool arguments, answer (judged by a model), resulting files, and end to end.

```bash
npm run evals -- run --local          # results go to $MINIBOT_HOME/evals/
npm run evals -- run --case file-edit-guarded
npm run evals -- sync                 # sync the cases to a Langfuse dataset
npm run evals -- run                  # with Langfuse configured, run as an experiment
```

## Development

```bash
npm test        # vitest; models come from pi-ai's faux provider
npm run check   # tsc type check
```

The source is TypeScript that Node 24 runs directly, with no build step; the web front end is bundled with esbuild when `minibot-server` starts. The design notes (in Chinese) are in [docs/architecture.md](docs/architecture.md).

## License

MIT, see [LICENSE](LICENSE).
