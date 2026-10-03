// Fire scheduled prompts as unattended runs.
//
// A cron or one-shot task runs in a fresh session (searchable later with
// search_history) and its reply arrives as a desktop notification. A
// heartbeat patrols in one persistent session, checks the HEARTBEAT.md
// checklist, and stays quiet unless something needs the user. Missed
// firings within the grace window catch up; older ones are recorded and
// skipped. Nobody is there to approve, so sensitive tools are denied.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentSession } from "../runtime/agent-session.ts";
import { RunCancelledError } from "../runtime/agent-session.ts";
import type { SessionStore } from "../session/store.ts";
import { errorName, preview } from "../util.ts";
import { nextRun, type ScheduledTask, type ScheduleStore, shortLocal } from "./schedule.ts";

export const HEARTBEAT_OK = "HEARTBEAT_OK";
const GRACE_MS = 60 * 60 * 1000;

const HEARTBEAT_TEMPLATE = `# Heartbeat 巡逻清单
#
# 每次心跳时 agent 会读这份清单逐项检查。井号开头的行是注释。
# 用祈使句写检查项,例如:
#
# - 检查未读邮件,有重要的立即通知我
# - 如果 30 分钟内有日程开始,提醒我
# - 看看 ~/Downloads 里有没有超过一周没整理的文件
#
# 清单为空时心跳会安静地跳过。
`;

export type Notifier = (title: string, body: string) => void;

/** Best-effort macOS notification; does nothing elsewhere. */
export const macosNotify: Notifier = (title, body) => {
	if (process.platform !== "darwin") return;
	const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
	execFile("osascript", ["-e", script], { timeout: 10_000 }, () => {});
};

export interface SchedulerDeps {
	schedule: ScheduleStore;
	session: AgentSession;
	store: SessionStore;
	heartbeatPath: string;
	notify: Notifier;
	log: (message: string) => void;
}

export class Scheduler {
	readonly #deps: SchedulerDeps;

	constructor(deps: SchedulerDeps) {
		this.#deps = deps;
	}

	/** Fire every task that is due at `now`; returns the ids fired. */
	async tick(now = new Date()): Promise<string[]> {
		const fired: string[] = [];
		for (const task of this.#deps.schedule.list()) {
			const due = nextRun(task, now);
			if (due === null || due > now) continue;
			if (now.getTime() - due.getTime() > GRACE_MS) {
				// Too stale (asleep, daemon down): record the miss and move on from now.
				this.#mark(task, "missed", now);
				this.#deps.log(`错过触发窗口,跳过: ${task.title}(应于 ${shortLocal(due)})`);
				continue;
			}
			await (task.kind === "heartbeat" ? this.#heartbeat(task, now) : this.#fire(task, now));
			fired.push(task.id);
		}
		return fired;
	}

	async run(signal: AbortSignal, intervalMs = 30_000): Promise<void> {
		this.#deps.log("scheduler 已启动");
		while (!signal.aborted) {
			try {
				await this.tick();
			} catch (error) {
				this.#deps.log(`scheduler tick 失败: ${(error as Error).message}`);
			}
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, intervalMs);
				signal.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve(undefined);
				}, { once: true });
			});
		}
	}

	async #fire(task: ScheduledTask, now: Date): Promise<void> {
		this.#deps.log(`触发定时任务: ${task.title}`);
		const session = this.#deps.store.create(`[定时] ${task.title} · ${shortLocal(now)}`);
		const prompt = `[定时任务「${task.title}」的无人值守运行。没有用户在场:不要提问,敏感工具默认会被拒绝,直接产出最终结果。]\n${task.prompt}`;
		const reply = await this.#run(task, session.id, prompt, "scheduler", now);
		if (reply === undefined) return;
		this.#mark(task, "success", now);
		this.#deps.notify(`MiniBot: ${task.title}`, preview(reply, 160) || "(完成,无文字输出)");
	}

	async #heartbeat(task: ScheduledTask, now: Date): Promise<void> {
		this.#deps.log(`心跳巡逻: ${task.title}`);
		let session = task.sessionId ? this.#deps.store.load(task.sessionId) : undefined;
		if (!session) {
			session = this.#deps.store.create(`[心跳] ${task.title}`);
			this.#deps.schedule.update(task.id, { sessionId: session.id });
		}
		const checklist = this.#checklist();
		const lines = [
			`[心跳巡逻 · ${shortLocal(now)} · 无人值守:不要提问,敏感工具默认被拒。]`,
			"逐项检查下面的巡逻清单,该做的直接做;只有真正需要用户注意的事才写进回复。",
			`如果没有任何需要用户注意的事,回复中必须包含 ${HEARTBEAT_OK}(可以附一句简短原因)——这会让通知保持安静。`,
		];
		if (task.prompt.trim()) lines.push(`附加常设指令: ${task.prompt.trim()}`);
		lines.push(
			checklist
				? `巡逻清单如下(已从 HEARTBEAT.md 内联,不需要再去读清单文件):\n${checklist}`
				: `巡逻清单为空(用户可以编辑 ${this.#deps.heartbeatPath}),直接回复 ${HEARTBEAT_OK}。`,
		);
		const reply = await this.#run(task, session.id, lines.join("\n"), "heartbeat", now);
		if (reply === undefined) return;
		if (reply.includes(HEARTBEAT_OK)) {
			this.#mark(task, "ok-quiet", now);
			return;
		}
		this.#mark(task, "attention", now);
		this.#deps.notify(`MiniBot 心跳: ${task.title}`, preview(reply, 160) || "(有情况,详见会话)");
	}

	/** The reply, or undefined after recording the failure. */
	async #run(task: ScheduledTask, sessionId: string, prompt: string, source: "scheduler" | "heartbeat", now: Date): Promise<string | undefined> {
		try {
			return (await this.#deps.session.prompt(sessionId, prompt, { source })).reply;
		} catch (error) {
			if (error instanceof RunCancelledError) {
				this.#mark(task, "cancelled", now);
				return undefined;
			}
			this.#mark(task, `failed: ${errorName(error)}`, now);
			this.#deps.notify(`MiniBot 任务失败: ${task.title}`, preview((error as Error).message, 120));
			return undefined;
		}
	}

	#checklist(): string {
		if (!existsSync(this.#deps.heartbeatPath)) writeFileSync(this.#deps.heartbeatPath, HEARTBEAT_TEMPLATE, "utf8");
		return readFileSync(this.#deps.heartbeatPath, "utf8")
			.split("\n")
			.filter((line) => line.trim() && !line.trimStart().startsWith("#"))
			.join("\n");
	}

	#mark(task: ScheduledTask, status: string, now: Date): void {
		this.#deps.schedule.update(task.id, {
			lastRunAt: now.toISOString(),
			lastStatus: status,
			...(task.kind === "once" ? { enabled: false } : {}),
		});
	}
}
