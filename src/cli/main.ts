// `minibot`: the terminal UI, or the line REPL when piped or with --plain.

import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../config.ts";
import { buildRuntime } from "../runtime/bootstrap.ts";
import { helpText } from "../ui/commands.ts";
import { runRepl } from "../ui/repl.ts";
import { runTui } from "../ui/tui.ts";
import { errorMessage } from "../util.ts";

const USAGE = `用法: minibot [--plain] [--verbose]

  --plain     使用行式 REPL(输入不是终端时自动使用)
  --verbose   显示模型请求、用量和启动信息
  -h, --help  显示帮助

配置在 $MINIBOT_HOME/.env(默认 ~/.minibot/.env),例如:
  DEEPSEEK_API_KEY=sk-...
  MINIBOT_MODEL=deepseek/deepseek-v4-pro

会话内命令:
${helpText()}`;

async function main(): Promise<number> {
	let flags: { plain?: boolean; verbose?: boolean; help?: boolean };
	try {
		flags = parseArgs({
			options: { plain: { type: "boolean" }, verbose: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" } },
		}).values;
	} catch (error) {
		console.error(`${errorMessage(error)}\n\n${USAGE}`);
		return 2;
	}
	if (flags.help) {
		console.log(USAGE);
		return 0;
	}
	let runtime: Awaited<ReturnType<typeof buildRuntime>>;
	try {
		runtime = await buildRuntime(loadConfig());
	} catch (error) {
		console.error(error instanceof ConfigError ? `配置错误: ${error.message}` : `启动失败: ${errorMessage(error)}`);
		return 1;
	}
	const verbose = flags.verbose ?? false;
	try {
		if (!flags.plain && process.stdin.isTTY && process.stdout.isTTY) await runTui(runtime, { verbose });
		else await runRepl(runtime, { verbose });
	} finally {
		await runtime.close();
	}
	return 0;
}

// Exit explicitly: MCP children and open sockets must not keep the process alive.
process.exit(await main());
