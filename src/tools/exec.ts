// Shell commands in the workspace, under bash with pipefail.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { failure, success, type ToolOutput } from "./result.ts";
import { defineTool, type Tool } from "./tool.ts";

const DANGEROUS: [RegExp, string][] = [
	[/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, "rm -rf(递归强制删除)"],
	[/\bdd\b/, "dd(磁盘级写入/擦除)"],
	[/:\s*\(\s*\)\s*\{.*:\s*\|.*&.*\}/, "Fork 炸弹"],
	[/\bmkfs\b/, "mkfs(格式化磁盘)"],
	[/\bfdisk\b|\bparted\b/, "磁盘分区工具"],
	[/>\s*\/dev\/(s|h|v|xv)d[a-z]/, "直接写入磁盘设备"],
	[/\bchmod\s+(-R\s+)?777\b/, "chmod 777(开放全局写权限)"],
	[/\bchown\s+-R\b/, "chown -R(递归更改所有者)"],
	[/\bshred\b|\bwipe\b/, "shred/wipe(安全擦除文件)"],
	[/\bpoweroff\b|\breboot\b|\bshutdown\b|\bhalt\b/, "关机/重启命令"],
	[/\bkillall\b|\bpkill\s+-9\b/, "批量强制杀进程"],
	[/(curl|wget)\s+.*\|\s*(ba)?sh/, "管道执行远程脚本"],
	[/\biptables\s+-F\b|\bnft\s+flush\b/, "清空防火墙规则"],
	[/\bsudo\s+(su|-i|-s)\b/, "获取 root shell"],
];

export function dangerReason(command: string): string | undefined {
	return DANGEROUS.find(([pattern]) => pattern.test(command))?.[1];
}

const TIMEOUT_MS = 30_000;
const PREVIEW_CHARS = 2_000;
const MAX_CAPTURE = 1024 * 1024;
/** Under pipefail, `producer | head` exits 128 + SIGPIPE once head stops reading. */
const SIGPIPE_EXIT = 141;
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

interface Completed {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function run(command: string, cwd: string, signal: AbortSignal): Promise<Completed> {
	return new Promise((resolve, reject) => {
		const args = SHELL.endsWith("bash") ? ["-o", "pipefail", "-c", command] : ["-c", command];
		const child = spawn(SHELL, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
		});
		const killGroup = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, TIMEOUT_MS);
		const onAbort = () => killGroup();
		signal.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

export const execTool: Tool = defineTool({
	name: "exec",
	description: "执行 shell 命令",
	requiresApproval: true,
	parameters: Type.Object({
		command: Type.String({ description: "要执行的命令,例如 ls -l 或 pwd,注意不要执行危险命令" }),
	}),
	async execute(args, context): Promise<ToolOutput> {
		const danger = dangerReason(args.command);
		if (danger) {
			return failure("permission_denied", "命令被安全策略拒绝执行。", { data: { command: args.command, reason: danger } });
		}
		const result = await run(args.command, context.workspace, context.signal);
		if (context.signal.aborted) throw context.signal.reason;
		if (result.timedOut) {
			return failure("timeout", `命令执行超过 ${TIMEOUT_MS / 1000} 秒,已终止。`, {
				data: { command: args.command, timeout_seconds: TIMEOUT_MS / 1000 },
			});
		}
		const code = result.code ?? -1;
		const truncated = result.stdout.length > PREVIEW_CHARS || result.stderr.length > PREVIEW_CHARS;
		const data: Record<string, unknown> = { command: args.command, exit_code: code };
		if (result.stdout.length > PREVIEW_CHARS) data.stdout_preview = result.stdout.slice(0, PREVIEW_CHARS);
		else data.stdout = result.stdout;
		if (result.stderr.length > PREVIEW_CHARS) data.stderr_preview = result.stderr.slice(0, PREVIEW_CHARS);
		else data.stderr = result.stderr;
		const extra = {
			data,
			truncated,
			content: truncated
				? `$ ${args.command}\n[exit_code] ${code}\n\n[stdout]\n${result.stdout}\n\n[stderr]\n${result.stderr}`
				: undefined,
			contentName: "exec_output",
		};
		if (code === SIGPIPE_EXIT) {
			return success(`命令已执行,退出码 ${code}(管道下游提前停止读取,上游收到 SIGPIPE,通常无害)。`, extra);
		}
		if (code !== 0) return failure("error", `命令执行失败,退出码 ${code}。`, extra);
		return success(`命令已执行,退出码 ${code}。`, extra);
	},
});
