// `minibot-daemon`: one scheduler per MINIBOT_HOME, firing scheduled tasks.

import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, paths } from "../config.ts";
import { buildRuntime } from "../runtime/bootstrap.ts";
import { errorMessage } from "../util.ts";
import { macosNotify, Scheduler } from "./scheduler.ts";

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
			const pid = Number(readFileSync(path, "utf8").trim());
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				rmSync(path, { force: true }); // Left behind by a dead daemon.
			}
		}
	}
	return false;
}

async function main(): Promise<number> {
	const { values } = parseArgs({ options: { workspace: { type: "string" } } });
	const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig({ workspace: values.workspace });
	} catch (error) {
		console.error(error instanceof ConfigError ? `配置错误: ${error.message}` : errorMessage(error));
		return 1;
	}
	const layout = paths(config.home);
	if (!claimPidFile(layout.daemonPid)) {
		console.error("已有 scheduler daemon 在运行,退出。");
		return 1;
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

process.exit(await main());
