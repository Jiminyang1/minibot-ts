// Fire scheduled prompts as unattended runs.
//
// A cron or one-shot task runs in a fresh session (searchable later with
// search_history) and its reply arrives as a desktop notification. A
// heartbeat patrols in one persistent session, checks the HEARTBEAT.md
// checklist, and stays quiet unless something needs the user. Missed
// firings within the grace window catch up; older ones are recorded and
// skipped. Nobody is there to approve, so sensitive tools are denied.
//
// The daemon runs unattended for months, so every failure stays contained:
// one broken task is switched off without stopping the others, a run that
// hangs is cancelled after RUN_TIMEOUT_MS, a task that keeps failing
// notifies only once per streak, and shutting down cancels the running task
// so its session is closed properly.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentSession } from "../runtime/agent-session.ts";
import { makeRunId, RunCancelledError } from "../runtime/agent-session.ts";
import type { SessionStore } from "../session/store.ts";
import { errorMessage, errorName, preview } from "../util.ts";
import { nextRun, type ScheduledTask, type ScheduleStore, shortLocal } from "./schedule.ts";

export const HEARTBEAT_OK = "HEARTBEAT_OK";
const GRACE_MS = 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

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
	/** A run that takes longer is cancelled; default RUN_TIMEOUT_MS. */
	runTimeoutMs?: number;
}

export class Scheduler {
	readonly #deps: SchedulerDeps;

	constructor(deps: SchedulerDeps) {
		this.#deps = deps;
	}

	/** Fire every task that is due at `now`; returns the ids fired. `stop` cancels the running task. */
	async tick(now = new Date(), stop?: AbortSignal): Promise<string[]> {
		const fired: string[] = [];
		for (const task of this.#deps.schedule.list()) {
			if (stop?.aborted) break;
			let due: Date | null;
			try {
				due = nextRun(task, now);
			} catch (error) {
				// A hand-edited expression that never fires: switch it off once, keep the others going.
				this.#deps.schedule.update(task.id, { enabled: false, lastStatus: `invalid: ${errorMessage(error)}` });
				this.#deps.log(`任务无法计算触发时间,已停用: ${task.title}`);
				this.#deps.notify(`MiniBot 任务已停用: ${task.title}`, preview(errorMessage(error), 120));
				continue;
			}
			if (due === null || due > now) continue;
			if (now.getTime() - due.getTime() > GRACE_MS) {
				// Too stale (asleep, daemon down): record the miss and move on from now.
				this.#mark(task, "missed", now, task.failures);
				this.#deps.log(`错过触发窗口,跳过: ${task.title}(应于 ${shortLocal(due)})`);
				continue;
			}
			await (task.kind === "heartbeat" ? this.#heartbeat(task, now, stop) : this.#fire(task, now, stop));
			fired.push(task.id);
		}
		return fired;
	}

	async run(signal: AbortSignal, intervalMs = 30_000): Promise<void> {
		this.#deps.log("scheduler 已启动");
		while (!signal.aborted) {
			try {
				await this.tick(new Date(), signal);
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

	async #fire(task: ScheduledTask, now: Date, stop: AbortSignal | undefined): Promise<void> {
		this.#deps.log(`触发定时任务: ${task.title}`);
		const session = this.#deps.store.create(`[定时] ${task.title} · ${shortLocal(now)}`);
		const prompt = `[定时任务「${task.title}」的无人值守运行。没有用户在场:不要提问,敏感工具默认会被拒绝,直接产出最终结果。]\n${task.prompt}`;
		const reply = await this.#run(task, session.id, prompt, "scheduler", now, stop);
		if (reply === undefined) return;
		this.#mark(task, "success", now, 0);
		this.#deps.notify(`MiniBot: ${task.title}`, preview(reply, 160) || "(完成,无文字输出)");
	}

	async #heartbeat(task: ScheduledTask, now: Date, stop: AbortSignal | undefined): Promise<void> {
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
		const reply = await this.#run(task, session.id, lines.join("\n"), "heartbeat", now, stop);
		if (reply === undefined) return;
		if (reply.includes(HEARTBEAT_OK)) {
			this.#mark(task, "ok-quiet", now, 0);
			return;
		}
		this.#mark(task, "attention", now, 0);
		this.#deps.notify(`MiniBot 心跳: ${task.title}`, preview(reply, 160) || "(有情况,详见会话)");
	}

	/** The reply, or undefined after recording the failure. */
	async #run(
		task: ScheduledTask,
		sessionId: string,
		prompt: string,
		source: "scheduler" | "heartbeat",
		now: Date,
		stop: AbortSignal | undefined,
	): Promise<string | undefined> {
		const { session } = this.#deps;
		const runId = makeRunId();
		const timeoutMs = this.#deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			session.abort(runId);
		}, timeoutMs);
		const onStop = () => session.abort(runId);
		stop?.addEventListener("abort", onStop, { once: true });
		try {
			return (await session.prompt(sessionId, prompt, { source, runId })).reply;
		} catch (error) {
			if (timedOut) {
				this.#fail(task, "timeout", `运行超过 ${Math.round(timeoutMs / 60_000)} 分钟,已取消。`, now);
			} else if (error instanceof RunCancelledError) {
				this.#mark(task, "cancelled", now, task.failures);
			} else {
				this.#fail(task, `failed: ${errorName(error)}`, errorMessage(error), now);
			}
			return undefined;
		} finally {
			clearTimeout(timer);
			stop?.removeEventListener("abort", onStop);
		}
	}

	/** A failed run; only the first failure of a streak notifies, so a broken task cannot flood the screen. */
	#fail(task: ScheduledTask, status: string, reason: string, now: Date): void {
		const failures = task.failures + 1;
		this.#mark(task, status, now, failures);
		this.#deps.log(`任务失败(连续第 ${failures} 次): ${task.title}: ${reason}`);
		if (failures === 1) this.#deps.notify(`MiniBot 任务失败: ${task.title}`, preview(reason, 120));
	}

	#checklist(): string {
		if (!existsSync(this.#deps.heartbeatPath)) writeFileSync(this.#deps.heartbeatPath, HEARTBEAT_TEMPLATE, "utf8");
		return readFileSync(this.#deps.heartbeatPath, "utf8")
			.split("\n")
			.filter((line) => line.trim() && !line.trimStart().startsWith("#"))
			.join("\n");
	}

	#mark(task: ScheduledTask, status: string, now: Date, failures: number): void {
		this.#deps.schedule.update(task.id, {
			lastRunAt: now.toISOString(),
			lastStatus: status,
			failures,
			...(task.kind === "once" ? { enabled: false } : {}),
		});
	}
}
