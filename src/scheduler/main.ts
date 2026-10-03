// `minibot-daemon`: one scheduler per MINIBOT_HOME, firing scheduled tasks.
//
//   minibot-daemon [--workspace DIR]           run in the foreground
//   minibot-daemon install [--workspace DIR]   run at login under launchd (macOS)
//   minibot-daemon uninstall                   stop running at login

import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type Config, ConfigError, loadConfig, paths } from "../config.ts";
import { buildRuntime, resolveModel } from "../runtime/bootstrap.ts";
import { errorMessage, sleep } from "../util.ts";
import { agentPath, removeAgent, startAgent, stopAgent } from "./launchd.ts";
import { macosNotify, Scheduler } from "./scheduler.ts";

const USAGE = `用法: minibot-daemon [install | uninstall] [--workspace DIR]

  (无)        在前台运行 scheduler
  install     开机自动运行(macOS launchd),工作目录默认是主目录
  uninstall   取消开机自动运行`;

/** The pid of a live daemon holding the pid file, if any. */
function livePid(path: string): number | undefined {
	let pid: number;
	try {
		pid = Number(readFileSync(path, "utf8").trim());
	} catch {
		return undefined;
	}
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		return undefined;
	}
}

/** Claim the pid file; false when a live daemon already holds it. */
function claimPidFile(path: string): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (livePid(path) !== undefined) return false;
			rmSync(path, { force: true }); // Left behind by a dead daemon.
		}
	}
	return false;
}

async function run(config: Config): Promise<number> {
	const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
	const layout = paths(config.home);
	if (!claimPidFile(layout.daemonPid)) {
		// A clean exit: launchd restarts the daemon only after a failure.
		console.error("已有 scheduler daemon 在运行,退出。");
		return 0;
	}
	try {
		// No approval handler: unattended runs deny sensitive tools.
		const runtime = await buildRuntime(config);
		for (const note of runtime.notes) log(note);
		const scheduler = new Scheduler({
			schedule: runtime.schedule,
			session: runtime.session,
			store: runtime.store,
			heartbeatPath: layout.heartbeat,
			notify: macosNotify,
			log,
		});
		const controller = new AbortController();
		process.on("SIGINT", () => controller.abort());
		process.on("SIGTERM", () => controller.abort());
		await scheduler.run(controller.signal);
		await runtime.close();
		log("scheduler 已停止");
		return 0;
	} catch (error) {
		console.error(`启动失败: ${errorMessage(error)}`);
		return 1;
	} finally {
		rmSync(layout.daemonPid, { force: true });
	}
}

async function install(config: Config): Promise<number> {
	// A config launchd cannot run would restart and fail forever; check it first.
	await resolveModel(builtinModels(), config);
	const layout = paths(config.home);
	stopAgent();
	for (let waited = 0; livePid(layout.daemonPid) !== undefined && waited < 10_000; waited += 250) await sleep(250);
	const manual = livePid(layout.daemonPid);
	if (manual !== undefined) {
		console.error(`有一个手动启动的 daemon 在运行(pid ${manual})。先停掉它,再安装。`);
		return 1;
	}
	const env: Record<string, string> = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}` };
	if (process.env.MINIBOT_HOME) env.MINIBOT_HOME = config.home;
	const path = startAgent({
		node: process.execPath,
		script: fileURLToPath(new URL("../../bin/minibot-daemon.js", import.meta.url)),
		workspace: config.workspace,
		log: layout.daemonLog,
		env,
	});
	console.log(`已安装,daemon 现在开始运行,以后登录时自动启动。\n  配置: ${path}\n  日志: ${layout.daemonLog}\n  工作目录: ${config.workspace}`);
	console.log("换了 Node 版本或移动了 minibot-ts 目录后,需要重新运行 install。");
	return 0;
}

async function main(): Promise<number> {
	let parsed: { values: { workspace?: string }; positionals: string[] };
	try {
		parsed = parseArgs({ allowPositionals: true, options: { workspace: { type: "string" } } });
	} catch (error) {
		console.error(`${errorMessage(error)}\n\n${USAGE}`);
		return 2;
	}
	const command = parsed.positionals[0];
	if (parsed.positionals.length > 1 || (command !== undefined && command !== "install" && command !== "uninstall")) {
		console.error(USAGE);
		return 2;
	}
	if (command !== undefined && process.platform !== "darwin") {
		console.error("install / uninstall 只支持 macOS。");
		return 1;
	}
	if (command === "uninstall") {
		console.log(removeAgent() ? "已取消开机自动运行,daemon 已停止。" : `没有安装(${agentPath()} 不存在)。`);
		return 0;
	}
	try {
		const config = loadConfig({ workspace: parsed.values.workspace ?? (command === "install" ? homedir() : undefined) });
		return command === "install" ? await install(config) : await run(config);
	} catch (error) {
		console.error(error instanceof ConfigError ? `配置错误: ${error.message}` : errorMessage(error));
		return 1;
	}
}

process.exit(await main());
