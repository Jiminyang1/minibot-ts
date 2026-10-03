// `minibot-daemon`: one scheduler per MINIBOT_HOME, firing scheduled tasks.
//
//   minibot-daemon [--workspace DIR]           run in the foreground
//   minibot-daemon install [--workspace DIR]   run at login under launchd (macOS)
//   minibot-daemon uninstall                   stop running at login
//
// Under launchd a clean exit stays down and a failure restarts. A problem a
// restart cannot fix (the config, a second daemon) therefore exits 0, so the
// daemon never restarts in a loop.

import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type Config, ConfigError, loadConfig, paths } from "../config.ts";
import { buildRuntime, resolveModel } from "../runtime/bootstrap.ts";
import { errorMessage, preview } from "../util.ts";
import { agentPath, removeAgent, startAgent, stopAgent } from "./launchd.ts";
import { macosNotify, Scheduler } from "./scheduler.ts";

const USAGE = `用法: minibot-daemon [install | uninstall] [--workspace DIR]

  (无)        在前台运行 scheduler
  install     开机自动运行(macOS launchd),工作目录默认是 $MINIBOT_HOME/workspace
  uninstall   取消开机自动运行`;

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** launchd only ever appends to the log; keep one previous copy and start over past the cap. */
function rotateLog(path: string): void {
	try {
		if (statSync(path).size <= MAX_LOG_BYTES) return;
		copyFileSync(path, `${path}.1`);
		truncateSync(path, 0);
	} catch {
		// No log yet.
	}
}

/** A config problem will not fix itself: report it once and exit cleanly. */
function stopForConfig(error: ConfigError): number {
	console.error(`配置错误: ${error.message}`);
	macosNotify("MiniBot daemon 已停止", preview(`配置错误: ${error.message} 修好后运行 minibot-daemon install。`, 200));
	return 0;
}

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
	const layout = paths(config.home);
	const log = (message: string) => {
		rotateLog(layout.daemonLog);
		console.log(`${new Date().toISOString()} ${message}`);
	};
	if (!claimPidFile(layout.daemonPid)) {
		// A clean exit: launchd restarts the daemon only after a failure.
		log("已有 scheduler daemon 在运行,退出。");
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
		if (error instanceof ConfigError) return stopForConfig(error);
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
	await stopAgent();
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
		console.log((await removeAgent()) ? "已取消开机自动运行,daemon 已停止。" : `没有安装(${agentPath()} 不存在)。`);
		return 0;
	}
	try {
		const config = loadConfig({ workspace: parsed.values.workspace });
		if (command !== "install") return await run(config);
		// Unattended runs get their own directory, not the whole home: file reads stay away from keys and other secrets.
		const workspace = parsed.values.workspace === undefined ? join(config.home, "workspace") : config.workspace;
		mkdirSync(workspace, { recursive: true });
		return await install({ ...config, workspace });
	} catch (error) {
		if (error instanceof ConfigError && command === undefined) return stopForConfig(error);
		console.error(error instanceof ConfigError ? `配置错误: ${error.message}` : errorMessage(error));
		return 1;
	}
}

process.exit(await main());
