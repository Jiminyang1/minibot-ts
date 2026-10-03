// Fire scheduled prompts as unattended runs.
//
// A cron or one-shot task runs in a fresh session (searchable later with
// search_history) and its reply arrives as a desktop notification. Missed
// firings within the grace window catch up; older ones are recorded and
// skipped. Nobody is there to approve, so sensitive tools are denied.
//
// A heartbeat patrols the HEARTBEAT.md checklist and stays quiet unless
// something needs the user. Every patrol starts from a clean context in its
// one session (a reset whose handoff is the note the last patrol left), so
// its cost stays flat however long it runs. It ends by calling
// heartbeat_respond: notify or not, and the note for the next patrol. A
// patrol that forgets to respond notifies with its reply, so no alert is
// lost. An empty checklist, or a time outside the active hours, skips the
// patrol without calling the model.
//
// The daemon runs unattended for months, so every failure stays contained:
// one broken task is switched off without stopping the others, a run that
// hangs is cancelled after RUN_TIMEOUT_MS, a task that keeps failing
// notifies only once per streak, and shutting down cancels the running task
// so its session is closed properly.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { type ActiveHours, inActiveHours } from "../config.ts";
import type { AgentSession } from "../runtime/agent-session.ts";
import { makeRunId, RunCancelledError } from "../runtime/agent-session.ts";
import { estimateMessageTokens } from "../runtime/context.ts";
import type { SessionStore } from "../session/store.ts";
import { failure, success } from "../tools/result.ts";
import { defineTool, type Tool } from "../tools/tool.ts";
import { errorMessage, errorName, preview } from "../util.ts";
import { nextRun, type ScheduledTask, type ScheduleStore, shortLocal } from "./schedule.ts";

const GRACE_MS = 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SCRATCH_CHARS = 2_000;

const HEARTBEAT_TEMPLATE = `# Heartbeat 巡逻清单
#
# 每次心跳时 agent 会读这份清单逐项检查。井号开头的行是注释。
# 用祈使句写检查项,例如:
#
# - 检查未读邮件,有重要的立即通知我
# - 如果 30 分钟内有日程开始,提醒我
# - 看看 ~/Downloads 里有没有超过一周没整理的文件
#
# 清单为空时心跳会跳过,不调用模型。
`;

export type Notifier = (title: string, body: string) => void;

/** Best-effort macOS notification; does nothing elsewhere. */
export const macosNotify: Notifier = (title, body) => {
	if (process.platform !== "darwin") return;
	const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
	execFile("osascript", ["-e", script], { timeout: 10_000 }, () => {});
};

interface HeartbeatResponse {
	notify: boolean;
	text: string;
	scratch: string | undefined;
}

export interface SchedulerDeps {
	schedule: ScheduleStore;
	session: AgentSession;
	store: SessionStore;
	heartbeatPath: string;
	notify: Notifier;
	log: (message: string) => void;
	/** A run that takes longer is cancelled; default RUN_TIMEOUT_MS. */
	runTimeoutMs?: number;
	/** Heartbeats outside this window are skipped. */
	activeHours?: ActiveHours;
}

export class Scheduler {
	readonly #deps: SchedulerDeps;
	/** The patrol in progress: only its run may respond. */
	#patrol: { runId: string; response: HeartbeatResponse | undefined } | undefined;
	/** How a patrol reports; the daemon registers it. */
	readonly respondTool: Tool;

	constructor(deps: SchedulerDeps) {
		this.#deps = deps;
		this.respondTool = defineTool({
			name: "heartbeat_respond",
			label: "心跳 · 回报",
			description:
				"只在心跳巡逻里使用:巡逻结束前调用一次,报告结果。notify=true 时 text 写给用户的提醒(会作为系统通知发出);没有需要用户注意的事就 notify=false。" +
				`scratch 可选,写下次巡逻需要记住的事(例如已经提醒过的事项,避免重复提醒),会整段替换旧笔记,最多 ${MAX_SCRATCH_CHARS} 字。`,
			parameters: Type.Object({
				notify: Type.Boolean({ description: "是否通知用户" }),
				text: Type.Optional(Type.String({ description: "notify=true 时给用户的提醒" })),
				scratch: Type.Optional(Type.String({ description: "留给下次巡逻的笔记,整段替换" })),
			}),
			execute: (args, context) => {
				const patrol = this.#patrol;
				if (patrol?.runId !== context.runId) return failure("invalid_args", "heartbeat_respond 只能在心跳巡逻中使用。");
				const text = args.text?.trim() ?? "";
				if (args.notify && !text) return failure("invalid_args", "notify=true 时 text 不能为空。");
				if (args.scratch !== undefined && args.scratch.length > MAX_SCRATCH_CHARS) {
					return failure("invalid_args", `scratch 有 ${args.scratch.length} 字,超过上限 ${MAX_SCRATCH_CHARS};请精简后重新调用。`);
				}
				patrol.response = { notify: args.notify, text, scratch: args.scratch?.trim() };
				return success(args.notify ? "已记录:会通知用户。" : "已记录:保持安静。");
			},
		});
	}

	/** Handle every task that is due at `now`; returns their ids. `stop` cancels the running task. */
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
		const { activeHours, schedule, store } = this.#deps;
		if (activeHours && !inActiveHours(activeHours, now)) {
			this.#mark(task, "skipped-hours", now, task.failures);
			return;
		}
		const checklist = this.#checklist();
		const standing = task.prompt.trim();
		if (!checklist && !standing) {
			this.#mark(task, "skipped-empty", now, task.failures);
			return;
		}
		this.#deps.log(`心跳巡逻: ${task.title}`);
		let session = task.sessionId ? store.load(task.sessionId) : undefined;
		if (!session) {
			session = store.create(`[心跳] ${task.title}`);
			schedule.update(task.id, { sessionId: session.id });
		}
		const handoff = task.scratch ? `上次巡逻留下的笔记:\n${task.scratch}` : "上次巡逻没有留下笔记。";
		store.reset(session, handoff, session.messages().reduce((sum, message) => sum + estimateMessageTokens(message), 0));
		const lines = [
			`[心跳巡逻 · ${shortLocal(now)} · 无人值守:不要提问,敏感工具默认被拒。]`,
			"逐项检查下面的内容,该查的直接查。",
			"结束前必须调用一次 heartbeat_respond:有真正需要用户注意的事就 notify=true 并写清提醒;没有就 notify=false。已经提醒过、情况也没变的事不要重复提醒,用 scratch 记下来。",
		];
		if (standing) lines.push(`常设指令: ${standing}`);
		if (checklist) lines.push(`巡逻清单(来自 HEARTBEAT.md,已内联):\n${checklist}`);
		const runId = makeRunId();
		this.#patrol = { runId, response: undefined };
		let reply: string | undefined;
		let response: HeartbeatResponse | undefined;
		try {
			reply = await this.#run(task, session.id, lines.join("\n"), "heartbeat", now, stop, runId);
			response = this.#patrol.response;
		} finally {
			this.#patrol = undefined;
		}
		if (reply === undefined) return;
		const scratch = response?.scratch === undefined ? {} : { scratch: response.scratch };
		if (response && !response.notify) {
			this.#mark(task, "ok-quiet", now, 0, scratch);
			return;
		}
		// Notify when asked, and when the patrol never answered: a lost alert costs more than an extra one.
		if (!response) this.#deps.log(`心跳没有调用 heartbeat_respond,按需要提醒处理: ${task.title}`);
		this.#mark(task, "attention", now, 0, scratch);
		this.#deps.notify(`MiniBot 心跳: ${task.title}`, preview(response?.text ?? reply, 160) || "(有情况,详见会话)");
	}

	/** The reply, or undefined after recording the failure. */
	async #run(
		task: ScheduledTask,
		sessionId: string,
		prompt: string,
		source: "scheduler" | "heartbeat",
		now: Date,
		stop: AbortSignal | undefined,
		runId = makeRunId(),
	): Promise<string | undefined> {
		const { session } = this.#deps;
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

	#mark(task: ScheduledTask, status: string, now: Date, failures: number, changes: Partial<ScheduledTask> = {}): void {
		this.#deps.schedule.update(task.id, {
			...changes,
			lastRunAt: now.toISOString(),
			lastStatus: status,
			failures,
			...(task.kind === "once" ? { enabled: false } : {}),
		});
	}
}
