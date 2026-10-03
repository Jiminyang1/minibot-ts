// Slash commands, shared by every terminal frontend.

import type { Runtime } from "../runtime/bootstrap.ts";
import { nextRun, shortLocal } from "../scheduler/schedule.ts";
import { errorMessage } from "../util.ts";

export interface Notice {
	kind: "info" | "success" | "warning" | "error";
	title: string;
	body?: string;
}

export interface CommandResult {
	notices: Notice[];
	/** The session the frontend should show from now on. */
	sessionId: string;
	exit?: boolean;
}

export interface CommandDef {
	name: string;
	usage: string;
	description: string;
	/** What the argument completes to. */
	argument?: "session" | "approval";
}

export const COMMANDS: readonly CommandDef[] = [
	{ name: "new", usage: "/new", description: "新建会话" },
	{ name: "sessions", usage: "/sessions", description: "查看所有会话" },
	{ name: "resume", usage: "/resume <id>", description: "切换到指定会话", argument: "session" },
	{ name: "rename", usage: "/rename <title>", description: "重命名当前会话" },
	{ name: "delete", usage: "/delete <id|current>", description: "删除会话", argument: "session" },
	{ name: "compact", usage: "/compact", description: "压缩当前会话" },
	{ name: "memory", usage: "/memory [clear|forget <id>]", description: "查看或管理长期记忆" },
	{ name: "tasks", usage: "/tasks [cancel <id>]", description: "查看或取消定时任务" },
	{ name: "skills", usage: "/skills", description: "查看可用 skills" },
	{ name: "mcp", usage: "/mcp [tools [server]]", description: "查看 MCP server 和工具" },
	{ name: "permission", usage: "/permission [ask|always]", description: "查看或切换审批模式", argument: "approval" },
	{ name: "config", usage: "/config", description: "查看当前运行配置" },
	{ name: "help", usage: "/help", description: "显示帮助" },
];

export function isCommand(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("/") || trimmed === "exit" || trimmed === "quit";
}

export function helpText(): string {
	const width = Math.max(...COMMANDS.map((command) => command.usage.length)) + 2;
	return [...COMMANDS.map((command) => `${command.usage.padEnd(width)}${command.description}`), `${"exit".padEnd(width)}退出`].join("\n");
}

function sessionLine(runtime: Runtime, id: string): string {
	const session = runtime.store.load(id);
	if (!session) return id;
	return `${id} · ${session.meta.title} · ${session.turnCount()} 轮 / ${session.meta.messageCount} 条`;
}

/** Run a slash command; never throws (failures become notices). */
export async function runCommand(raw: string, sessionId: string, runtime: Runtime): Promise<CommandResult> {
	try {
		return await dispatch(raw.trim(), sessionId, runtime);
	} catch (error) {
		return { sessionId, notices: [{ kind: "error", title: errorMessage(error) }] };
	}
}

async function dispatch(text: string, sessionId: string, runtime: Runtime): Promise<CommandResult> {
	const done = (...notices: Notice[]): CommandResult => ({ sessionId, notices });
	if (text === "exit" || text === "quit") return { sessionId, notices: [], exit: true };
	const [name, ...rest] = text.slice(1).split(/\s+/);
	const arg = rest.join(" ").trim();
	const { store, session } = runtime;

	switch (name) {
		case "help":
			return done({ kind: "info", title: "命令", body: helpText() });
		case "new": {
			const created = store.createCurrent();
			return { sessionId: created.id, notices: [{ kind: "success", title: `已创建新会话 ${created.id}` }] };
		}
		case "sessions": {
			const metas = store.list();
			const body = metas.length
				? metas.map((meta) => `${meta.id === sessionId ? "●" : " "} ${meta.id}  ${meta.title} · ${meta.messageCount} 条 · ${shortLocal(new Date(meta.updatedAt))}`).join("\n")
				: "还没有会话。";
			return done({ kind: "info", title: `会话 · ${metas.length} 个`, body });
		}
		case "resume": {
			if (!arg) return done({ kind: "info", title: "用法: /resume <id>" });
			const loaded = store.load(arg);
			if (!loaded) return done({ kind: "warning", title: `未找到会话: ${arg}` });
			store.setCurrent(loaded.id);
			return { sessionId: loaded.id, notices: [{ kind: "success", title: "已切换会话", body: sessionLine(runtime, loaded.id) }] };
		}
		case "rename": {
			if (!arg) return done({ kind: "info", title: "用法: /rename <title>" });
			const current = store.load(sessionId);
			if (!current) return done({ kind: "warning", title: `未找到会话: ${sessionId}` });
			store.rename(current, arg);
			return done({ kind: "success", title: `已重命名为「${arg}」` });
		}
		case "delete": {
			if (!arg) return done({ kind: "info", title: "用法: /delete <id|current>" });
			const target = arg === "current" ? sessionId : arg;
			if (session.isBusy(target)) return done({ kind: "warning", title: "会话正在运行,不能删除。" });
			if (!store.delete(target)) return done({ kind: "warning", title: `未找到会话: ${target}` });
			if (target !== sessionId) return done({ kind: "success", title: `已删除会话 ${target}` });
			const replacement = store.createCurrent();
			return {
				sessionId: replacement.id,
				notices: [
					{ kind: "success", title: `已删除会话 ${target}` },
					{ kind: "info", title: `已创建新会话 ${replacement.id}` },
				],
			};
		}
		case "compact": {
			const message = await session.compact(sessionId);
			return done(message ? { kind: "success", title: "已压缩当前会话", body: message } : { kind: "info", title: "没有可以压缩的旧内容。" });
		}
		case "memory": {
			const [sub, id] = rest;
			if (!sub) {
				const items = runtime.memory.list();
				return done({
					kind: "info",
					title: `长期记忆 · ${items.length} 条`,
					body: items.length ? items.map((item) => `${item.id}  ${item.content}`).join("\n") : "长期记忆为空。",
				});
			}
			if (sub === "clear") return done({ kind: "warning", title: `已清空长期记忆,删除 ${runtime.memory.clear()} 条` });
			if (sub === "forget" && id) {
				return done(runtime.memory.delete(id) ? { kind: "success", title: `已删除记忆 ${id}` } : { kind: "warning", title: `未找到记忆 ${id}` });
			}
			return done({ kind: "info", title: "用法: /memory | /memory clear | /memory forget <id>" });
		}
		case "tasks": {
			const [sub, id] = rest;
			if (sub === "cancel" && id) {
				return done(runtime.schedule.remove(id) ? { kind: "success", title: `已取消定时任务 ${id}` } : { kind: "warning", title: `未找到定时任务 ${id}` });
			}
			if (sub) return done({ kind: "info", title: "用法: /tasks | /tasks cancel <id>" });
			const tasks = runtime.schedule.list();
			const body = tasks.length
				? tasks
						.map((task) => {
							const next = nextRun(task);
							return `${task.id}  ${task.title} · ${task.kind}: ${task.expr} · 下次 ${next ? shortLocal(next) : "不再触发"} · 上次 ${task.lastStatus ?? "-"}`;
						})
						.join("\n")
				: "当前没有定时任务。可以直接说“每天早上 8 点给我生成今日简报”来创建。";
			return done({ kind: "info", title: `定时任务 · ${tasks.length} 个`, body });
		}
		case "skills": {
			const skills = runtime.context.visibleSkills();
			const body = skills.length ? skills.map((skill) => `${skill.name}  ${skill.description}`).join("\n") : "当前没有可用 skills。";
			return done({ kind: "info", title: `Skills · ${skills.length} 个`, body });
		}
		case "mcp": {
			const statuses = runtime.mcp.status();
			if (statuses.length === 0) return done({ kind: "info", title: "没有配置 MCP server", body: `配置文件: ${runtime.mcp.configPath}` });
			const only = rest[0] === "tools" ? rest[1] : undefined;
			const lines = statuses
				.filter((status) => only === undefined || status.name === only)
				.flatMap((status) => {
					const state = !status.enabled ? "disabled" : status.connected ? "connected" : status.error ? "failed" : "pending";
					const head = `${status.name}  ${status.transport}  ${state}  ${status.tools.length} tools  ${status.trusted ? "trusted" : "需审批"}`;
					const detail = rest[0] === "tools" ? status.tools.map((tool) => `  ${tool}`) : status.error ? [`  error: ${status.error}`] : [];
					return [head, ...detail];
				});
			return done({ kind: "info", title: "MCP", body: `配置: ${runtime.mcp.configPath}\n${lines.join("\n")}` });
		}
		case "permission": {
			if (arg === "ask" || arg === "always") runtime.approval.mode = arg;
			else if (arg) return done({ kind: "info", title: "用法: /permission [ask|always]" });
			const mode = runtime.approval.mode === "always" ? "always · 自动批准敏感工具" : "ask · 敏感工具需要确认";
			return done({ kind: arg ? "success" : "info", title: `审批模式: ${mode}` });
		}
		case "config": {
			const { config, budget, model } = runtime;
			const rows: [string, string | number][] = [
				["model", `${model.provider}/${model.id}`],
				["thinking", config.thinking],
				["approval", runtime.approval.mode],
				["context window", budget.contextWindow],
				["max output tokens", config.maxOutputTokens],
				["hard input limit", budget.hardLimit],
				["compact at", budget.compactAt],
				["keep recent tokens", config.keepRecentTokens],
				["max iterations", config.maxIterations],
				["max retries", config.maxRetries],
				["home", config.home],
				["workspace", config.workspace],
			];
			return done({ kind: "info", title: "Config", body: rows.map(([key, value]) => `${key}: ${value}`).join("\n") });
		}
		default:
			return done({ kind: "warning", title: `未知命令: /${name}`, body: "用 /help 查看可用命令。" });
	}
}
