# MiniBot

运行在你本机上的个人助理。它能读写文件、执行命令、查网页、记住关于你的事、按时间表自己干活,并通过 macOS 日历、提醒事项、备忘录和邮件替你办事。

TypeScript 实现,引擎是 [pi](https://github.com/earendil-works/pi) 的 `pi-ai`(模型接入)和 `pi-agent-core`(agent 循环);MiniBot 自己负责会话、压缩、审批、记忆、定时任务和界面。

## 快速开始

需要 Node.js 24 或更高版本。

```bash
npm install
mkdir -p ~/.minibot && echo "DEEPSEEK_API_KEY=sk-..." >> ~/.minibot/.env
npm start
```

想在任何目录直接用 `minibot` 命令:

```bash
npm link
```

三个入口:

| 命令 | 作用 |
|---|---|
| `minibot` | 终端界面。输入不是终端或加 `--plain` 时用行式 REPL。 |
| `minibot-server [--port 8765]` | Web 界面和 HTTP/SSE 接口,打开 `http://127.0.0.1:8765/`。 |
| `minibot-daemon` | 定时任务和心跳巡逻,每个数据目录只能跑一个。`install` 让它开机自动运行,`uninstall` 取消。 |

终端界面的按键:Enter 发送,Esc 取消运行,Ctrl+O 展开或收起思考过程,Ctrl+C 清空输入(运行中则取消,空闲时退出),Ctrl+D 退出。输入 `/` 会补全命令。

## 配置

配置来自环境变量,`$MINIBOT_HOME/.env`(默认 `~/.minibot/.env`)里的值只在变量未设置时生效。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MINIBOT_MODEL` | `deepseek/deepseek-v4-pro` | `provider/model`,来自 pi-ai 的模型目录 |
| `DEEPSEEK_API_KEY` 等 | — | 所选 provider 的凭据,变量名由 pi-ai 决定 |
| `MINIBOT_THINKING` | `medium` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `MINIBOT_MAX_OUTPUT_TOKENS` | `32000` | 每次请求的输出上限(不超过模型上限) |
| `MINIBOT_CONTEXT_WINDOW` | 模型目录 | 覆盖上下文窗口 |
| `MINIBOT_COMPACT_THRESHOLD` | 硬输入上限 | 请求超过这个 token 数时先压缩 |
| `MINIBOT_KEEP_RECENT_TOKENS` | `16000` | 压缩时原样保留的近期内容 |
| `MINIBOT_APPROVAL` | `ask` | `ask`:敏感工具先问;`always`:自动批准 |
| `MINIBOT_MAX_ITERATIONS` | `20` | 一轮对话里最多的模型请求次数 |
| `MINIBOT_MAX_RETRIES` | `3` | 模型还没输出任何内容就失败时的重试次数 |
| `MINIBOT_HOME` | `~/.minibot` | 数据目录 |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | — | 设置后启用 Langfuse 追踪;`MINIBOT_LANGFUSE=0` 关闭 |

注意:配上 Langfuse 后,每次请求的完整内容(包括记忆、邮件和日程)都会上传到 Langfuse。

## 会话内命令

| 命令 | 作用 |
|---|---|
| `/new` `/sessions` `/resume <id>` `/rename <title>` `/delete <id\|current>` | 会话管理 |
| `/compact` | 手动压缩当前会话 |
| `/memory [clear\|forget <id>]` | 查看或管理长期记忆 |
| `/tasks [cancel <id>]` | 查看或取消定时任务 |
| `/skills` `/mcp [tools [server]]` `/config` | 查看 skills、MCP 和配置 |
| `/permission [ask\|always]` | 查看或切换审批模式 |

## 工具

| 工具 | 说明 | 审批 |
|---|---|---|
| `read_file` `list_dir` `search_files` | 读取工作目录 | 否 |
| `write_file` `edit_file` | 写文件;覆盖或编辑已有文件需要上次读取得到的 sha256 | 是 |
| `exec` | 在工作目录用 `bash -o pipefail` 执行命令,30 秒超时,危险命令直接拒绝 | 是 |
| `web_search` `fetch_url` | 搜索公开网页,读取网页正文 | 否 |
| `read_artifact` | 分页读取过大的工具输出 | 否 |
| `remember` `forget` | 长期记忆 | 否 |
| `search_history` | 跨会话搜索历史对话 | 否 |
| `read_skill` | 按需加载 skill 正文 | 否 |
| `schedule_task` `list_scheduled_tasks` `cancel_scheduled_task` | 定时任务 | 创建需要 |
| `calendar_*` `reminders_*` `notes_*` `mail_*` | macOS 日历、提醒事项、备忘录、邮件(只在 macOS 上提供) | 写操作需要 |

工具和命令只能访问启动时的工作目录;会话、记忆和定时任务是全局的,存在数据目录里。

macOS 工具第一次访问某个 App 时,系统会请求自动化权限。App 没有运行时,工具会在后台打开它,然后重试一次。

## MCP

在 `$MINIBOT_HOME/mcp.json` 里配置 MCP server,工具以 `mcp__<server>__<tool>` 的名字出现。未标 `trusted` 的 server,工具调用需要审批。

```json
{
  "servers": {
    "drawio": { "command": "npx", "args": ["-y", "@drawio/mcp"], "timeoutSeconds": 60 },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" }, "trusted": true }
  }
}
```

`${VAR}` 从环境变量取值。

## 定时任务和心跳

直接用自然语言让 MiniBot 创建,例如"每天早上 8 点给我生成今日简报"。`minibot-daemon` 到点以无人值守方式执行:

- 普通任务在新会话里运行,结果通过 macOS 通知送达。
- 心跳任务在同一个会话里反复巡逻,按 `$MINIBOT_HOME/HEARTBEAT.md` 里的清单检查;没有需要你注意的事就保持安静。
- 错过的触发在 1 小时内会补跑,更早的记为 missed。
- 没有人可以审批,所以敏感工具一律拒绝。

daemon 必须一直运行,任务才会触发。在 macOS 上用 launchd 让它开机自动运行:

```bash
minibot-daemon install     # 工作目录默认是 $MINIBOT_HOME/workspace,可用 --workspace 指定
minibot-daemon uninstall
```

`install` 先检查配置和 API key,然后写入 `~/Library/LaunchAgents/local.minibot.daemon.plist` 并立即启动 daemon。换了 Node 版本或移动了仓库目录后,重新运行一次 `install`。

daemon 会连续运行几个月,所以它的每一种故障都被限制在小范围内:

- **不占机器资源:** 以后台优先级运行(macOS 会限制它的 CPU 和磁盘占用),堆内存上限 512 MB。
- **不会反复重启:** 异常退出后 launchd 才重启它,而且最多每分钟一次。配置错误不是重启能解决的,daemon 会发一条通知,然后正常退出,不再重启。
- **任务互不影响:** 一个任务的表达式坏了(比如手改 `schedule.json`),只停用这一个任务。
- **不会卡死:** 单次运行超过 10 分钟就取消。
- **不刷屏:** 任务连续失败时,只在第一次失败时通知。
- **不乱跑:** 周期任务至少间隔 5 分钟;永远不会触发的表达式在创建时就被拒绝。
- **停止时收尾:** 停止 daemon 会取消正在运行的任务,并给它的会话写上收尾记录。
- **日志有上限:** `daemon.log` 超过 5 MB 时转存为 `daemon.log.1`,然后从头写。
- **读不到密钥:** 默认工作目录是 `$MINIBOT_HOME/workspace`,不是主目录。无人值守的运行读不到 `~/.ssh`、`.env` 这类文件。

## 数据目录

```
~/.minibot/
  .env                      配置
  sessions/<id>/meta.json   会话标题、时间、消息数
  sessions/<id>/entries.jsonl  只追加的会话记录(唯一事实来源)
  sessions/<id>/artifacts/  过大的工具输出
  current-session           当前会话 id
  memory.json               长期记忆
  schedule.json             定时任务
  HEARTBEAT.md              心跳巡逻清单
  runs.jsonl                每次运行一行摘要
  mcp.json                  MCP server 配置
  daemon.pid / daemon.log   正在运行的 daemon 和它的日志
  workspace/                daemon 的默认工作目录
  evals/                    本地评测结果
```

## 评测

`evals/cases.json` 是黄金用例集。每个用例在沙箱里(临时数据目录和工作目录,macOS、命令和网页工具换成替身)用真实模型跑一轮,按 skill 选择、工具选择、工具参数、回答(由模型评判)、文件结果和端到端六个阶段打分。

```bash
npm run evals -- run --local          # 结果存到 $MINIBOT_HOME/evals/
npm run evals -- run --case file-edit-guarded
npm run evals -- sync                 # 同步用例到 Langfuse dataset
npm run evals -- run                  # 配了 Langfuse 时作为一次 experiment 运行
```

## 开发

```bash
npm test        # vitest,模型用 pi-ai 的 faux provider
npm run check   # tsc 类型检查
```

源码是 TypeScript,Node 24 直接运行,没有构建步骤;Web 前端在 `minibot-server` 启动时用 esbuild 打包。设计说明见 [docs/architecture.md](docs/architecture.md)。
