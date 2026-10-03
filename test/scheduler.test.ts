import { writeFileSync } from "node:fs";
import { type Context, fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type ActiveHours, inActiveHours, parseActiveHours } from "../src/config.ts";
import { AGENT_LABEL, agentPlist } from "../src/scheduler/launchd.ts";
import { cronNext, nextRun, parseCron, shortestInterval } from "../src/scheduler/schedule.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { messageText } from "../src/session/types.ts";
import { sleep } from "../src/util.ts";
import { testRuntime } from "./helpers.ts";

const local = (text: string) => new Date(text);

describe("cron", () => {
	it("finds the next matching minute in local time", () => {
		expect(cronNext("0 8 * * *", local("2026-07-07T07:59")).getTime()).toBe(local("2026-07-07T08:00").getTime());
		expect(cronNext("0 8 * * *", local("2026-07-07T08:00")).getTime()).toBe(local("2026-07-08T08:00").getTime());
		expect(cronNext("*/15 9-10 * * 1-5", local("2026-07-10T10:50")).getTime()).toBe(local("2026-07-13T09:00").getTime());
		expect(cronNext("0 0 1 1 *", local("2026-07-07T00:00")).getTime()).toBe(local("2027-01-01T00:00").getTime());
	});

	it("ORs day of month and day of week when both are restricted", () => {
		// 2026-07-01 is a Wednesday; Monday 2026-07-06 also matches.
		const hits = [cronNext("0 9 1 * 1", local("2026-06-30T10:00")), cronNext("0 9 1 * 1", local("2026-07-01T10:00"))];
		expect(hits.map((date) => date.getDate())).toEqual([1, 6]);
	});

	it("rejects malformed expressions", () => {
		expect(() => parseCron("0 8 * *")).toThrow();
		expect(() => parseCron("61 * * * *")).toThrow();
		expect(parseCron("0 0 * * 7").weekday.has(0)).toBe(true);
	});
});

async function scheduled(reply: string, options: { runTimeoutMs?: number; activeHours?: ActiveHours } = {}) {
	const test = await testRuntime();
	test.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage(reply)));
	const notes: string[] = [];
	const scheduler = new Scheduler({
		schedule: test.runtime.schedule,
		session: test.runtime.session,
		store: test.runtime.store,
		heartbeatPath: test.runtime.paths.heartbeat,
		notify: (title, body) => notes.push(`${title}: ${body}`),
		log: () => {},
		...options,
	});
	test.runtime.tools.register(scheduler.respondTool);
	return { ...test, scheduler, notes };
}

const minutes = (base: string, n: number) => new Date(Date.parse(base) + n * 60_000);
/** One patrol: the heartbeat_respond call, then the closing reply. */
const patrol = (args: JsonObject) => [
	fauxAssistantMessage([fauxToolCall("heartbeat_respond", args)], { stopReason: "toolUse" }),
	fauxAssistantMessage("巡逻完成"),
];
const slowReply = async () => {
	await sleep(300);
	return fauxAssistantMessage("太慢了");
};

describe("scheduler", () => {
	it("fires a due cron task in a new session and notifies", async () => {
		const { runtime, scheduler, notes } = await scheduled("今日简报已生成");
		const task = runtime.schedule.add({ title: "简报", prompt: "生成简报", kind: "cron", expr: "*/5 * * * *", workspace: "/w" });
		const now = minutes(task.createdAt, 6);
		expect(await scheduler.tick(now)).toEqual([task.id]);
		expect(notes).toEqual(["MiniBot: 简报: 今日简报已生成"]);
		const updated = runtime.schedule.get(task.id);
		expect(updated).toMatchObject({ lastStatus: "success", lastRunAt: now.toISOString() });
		expect(runtime.store.list().some((meta) => meta.title.startsWith("[定时] 简报"))).toBe(true);
		// Not due again within the same minute.
		expect(await scheduler.tick(now)).toEqual([]);
	});

	it("skips firings older than the grace window", async () => {
		const { runtime, scheduler, notes } = await scheduled("x");
		const task = runtime.schedule.add({ title: "旧", prompt: "p", kind: "once", expr: "2020-01-01T09:00", workspace: "/w" });
		expect(await scheduler.tick(new Date())).toEqual([]);
		expect(runtime.schedule.get(task.id)).toMatchObject({ lastStatus: "missed", enabled: false });
		expect(nextRun(runtime.schedule.get(task.id)!)).toBeNull();
		expect(notes).toEqual([]);
	});

});

describe("heartbeat", () => {
	it("starts every patrol clean, carrying only the last note, and stays quiet", async () => {
		const { runtime, faux, scheduler, notes } = await scheduled("x");
		writeFileSync(runtime.paths.heartbeat, "# 注释\n- 检查邮件\n");
		let second: Context["messages"] = [];
		faux.setResponses([
			...patrol({ notify: false, scratch: "已提醒过: 邮件 A" }),
			(context) => {
				second = [...context.messages];
				return fauxAssistantMessage([fauxToolCall("heartbeat_respond", { notify: false })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("巡逻完成"),
		]);
		const task = runtime.schedule.add({ title: "巡逻", prompt: "", kind: "heartbeat", expr: "*/5 * * * *", workspace: "/w" });
		await scheduler.tick(minutes(task.createdAt, 6));
		await scheduler.tick(minutes(task.createdAt, 11));

		const updated = runtime.schedule.get(task.id);
		expect(updated).toMatchObject({ lastStatus: "ok-quiet", scratch: "已提醒过: 邮件 A" });
		expect(notes).toEqual([]);
		// The second request holds the system prompt, the handoff note, and the new patrol; nothing of the first patrol.
		expect(second.map((message) => message.role)).toEqual(["system", "user", "user"]);
		expect(JSON.stringify(second[1])).toContain("已提醒过: 邮件 A");
		expect(JSON.stringify(second[2])).toContain("检查邮件");
		// The log on disk keeps both patrols.
		const session = runtime.store.load(updated?.sessionId ?? "");
		expect(session?.entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
	});

	it("notifies with the patrol's own text", async () => {
		const { runtime, faux, scheduler, notes } = await scheduled("x");
		faux.setResponses(patrol({ notify: true, text: "有一封重要邮件需要回复" }));
		const task = runtime.schedule.add({ title: "巡逻", prompt: "看邮件", kind: "heartbeat", expr: "*/5 * * * *", workspace: "/w" });
		await scheduler.tick(minutes(task.createdAt, 6));
		expect(runtime.schedule.get(task.id)?.lastStatus).toBe("attention");
		expect(notes).toEqual(["MiniBot 心跳: 巡逻: 有一封重要邮件需要回复"]);
	});

	it("notifies with the reply when the patrol forgets to respond", async () => {
		const { runtime, scheduler, notes } = await scheduled("一切正常,只是 HEARTBEAT_OK 写在了中间");
		const task = runtime.schedule.add({ title: "巡逻", prompt: "看邮件", kind: "heartbeat", expr: "*/5 * * * *", workspace: "/w" });
		await scheduler.tick(minutes(task.createdAt, 6));
		expect(runtime.schedule.get(task.id)?.lastStatus).toBe("attention");
		expect(notes[0]).toContain("一切正常");
	});

	it("skips without calling the model when there is nothing to check, or outside the active hours", async () => {
		const empty = await scheduled("x");
		const idle = empty.runtime.schedule.add({ title: "空", prompt: "", kind: "heartbeat", expr: "*/5 * * * *", workspace: "/w" });
		await empty.scheduler.tick(minutes(idle.createdAt, 6));
		expect(empty.runtime.schedule.get(idle.id)).toMatchObject({ lastStatus: "skipped-empty", sessionId: null });
		expect(empty.faux.getPendingResponseCount()).toBe(4);

		const at = minutes(new Date().toISOString(), 6);
		const minute = at.getHours() * 60 + at.getMinutes();
		const night = await scheduled("x", { activeHours: { start: (minute + 60) % 1440, end: (minute + 120) % 1440 } });
		const task = night.runtime.schedule.add({ title: "夜", prompt: "看邮件", kind: "heartbeat", expr: "*/5 * * * *", workspace: "/w" });
		await night.scheduler.tick(minutes(task.createdAt, 6));
		expect(night.runtime.schedule.get(task.id)?.lastStatus).toBe("skipped-hours");
		expect(night.faux.getPendingResponseCount()).toBe(4);
	});

	it("accepts heartbeat_respond only from the patrol in progress", async () => {
		const { scheduler } = await scheduled("x");
		const context = { sessionId: "s", runId: "r_other", workspace: "/w", signal: new AbortController().signal };
		expect(await scheduler.respondTool.execute({ notify: false }, context)).toMatchObject({ ok: false, code: "invalid_args" });
	});

	it("parses active hours, including a window past midnight", () => {
		expect(parseActiveHours("08:00-23:00")).toEqual({ start: 480, end: 1380 });
		expect(parseActiveHours(undefined)).toBeUndefined();
		const night = parseActiveHours("22:00-06:30")!;
		expect(inActiveHours(night, new Date(2026, 0, 1, 23, 0))).toBe(true);
		expect(inActiveHours(night, new Date(2026, 0, 1, 6, 30))).toBe(false);
		expect(inActiveHours(night, new Date(2026, 0, 1, 12, 0))).toBe(false);
		expect(() => parseActiveHours("8-23")).toThrow();
		expect(() => parseActiveHours("08:00-08:00")).toThrow();
		expect(() => parseActiveHours("08:60-09:00")).toThrow();
	});
});

describe("scheduler robustness", () => {
	it("refuses tasks that fire too often or never", async () => {
		const { runtime } = await scheduled("x");
		const add = (expr: string) => runtime.schedule.add({ title: "t", prompt: "p", kind: "cron", expr, workspace: "/w" });
		expect(() => add("* * * * *")).toThrow("太频繁");
		expect(() => add("0,2 8 * * *")).toThrow("太频繁");
		expect(() => add("0 0 30 2 *")).toThrow("找不到");
		expect(add("*/5 * * * *").kind).toBe("cron");
		expect(shortestInterval("0 8 * * 1-5")).toBe(24 * 60);
	});

	it("switches off a broken task without stopping the others", async () => {
		const { runtime, scheduler, notes } = await scheduled("完成");
		const broken = runtime.schedule.add({ title: "坏", prompt: "p", kind: "cron", expr: "0 8 * * *", workspace: "/w" });
		runtime.schedule.update(broken.id, { expr: "0 0 30 2 *" }); // as if edited by hand
		const good = runtime.schedule.add({ title: "好", prompt: "p", kind: "cron", expr: "*/5 * * * *", workspace: "/w" });
		expect(await scheduler.tick(minutes(good.createdAt, 6))).toEqual([good.id]);
		expect(runtime.schedule.get(broken.id)).toMatchObject({ enabled: false });
		expect(runtime.schedule.get(broken.id)?.lastStatus).toMatch(/^invalid: /);
		expect(await scheduler.tick(minutes(good.createdAt, 11))).toEqual([good.id]);
		expect(notes.filter((note) => note.includes("已停用"))).toHaveLength(1);
	});

	it("cancels a hung run, and notifies once per failure streak", async () => {
		const { runtime, faux, scheduler, notes } = await scheduled("x", { runTimeoutMs: 50 });
		faux.setResponses([slowReply, slowReply, fauxAssistantMessage("恢复了")]);
		const task = runtime.schedule.add({ title: "慢", prompt: "p", kind: "cron", expr: "*/5 * * * *", workspace: "/w" });
		await scheduler.tick(minutes(task.createdAt, 6));
		expect(runtime.schedule.get(task.id)).toMatchObject({ lastStatus: "timeout", failures: 1 });
		await scheduler.tick(minutes(task.createdAt, 11));
		expect(runtime.schedule.get(task.id)).toMatchObject({ lastStatus: "timeout", failures: 2 });
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("任务失败");
		await scheduler.tick(minutes(task.createdAt, 16));
		expect(runtime.schedule.get(task.id)).toMatchObject({ lastStatus: "success", failures: 0 });
	});

	it("cancels the running task on shutdown and closes its session", async () => {
		const { runtime, faux, scheduler, notes } = await scheduled("x");
		faux.setResponses([slowReply]);
		const task = runtime.schedule.add({ title: "停", prompt: "p", kind: "cron", expr: "*/5 * * * *", workspace: "/w" });
		const stop = new AbortController();
		const ticking = scheduler.tick(minutes(task.createdAt, 6), stop.signal);
		await sleep(20);
		stop.abort();
		await ticking;
		expect(runtime.schedule.get(task.id)).toMatchObject({ lastStatus: "cancelled", failures: 0 });
		expect(notes).toEqual([]);
		const session = runtime.store.list().find((meta) => meta.title.startsWith("[定时] 停"));
		const last = runtime.store.load(session?.id ?? "")?.messages().at(-1);
		expect(last && messageText(last)).toContain("取消");
	});
});

describe("launchd agent", () => {
	it("runs the daemon in the background with absolute paths and a capped heap, restarts only after a failure, and escapes XML", () => {
		const plist = agentPlist({
			node: "/opt/node/bin/node",
			script: "/code/minibot-ts/bin/minibot-daemon.js",
			workspace: "/Users/me/R&D <x>",
			log: "/Users/me/.minibot/daemon.log",
			env: { PATH: "/opt/node/bin:/usr/bin", MINIBOT_HOME: "/Users/me/.minibot" },
		});
		expect(plist).toContain(`<key>Label</key><string>${AGENT_LABEL}</string>`);
		expect(plist).toMatch(/<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>--max-old-space-size=512<\/string>\s*<string>\/code\/minibot-ts\/bin\/minibot-daemon.js<\/string>\s*<string>--workspace<\/string>\s*<string>\/Users\/me\/R&amp;D &lt;x&gt;<\/string>\s*<\/array>/);
		expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
		expect(plist).toContain("<key>ProcessType</key><string>Background</string>");
		expect(plist).toContain("<key>ThrottleInterval</key><integer>60</integer>");
		expect(plist).toContain("<key>ExitTimeOut</key><integer>20</integer>");
		expect(plist).toContain("<key>MINIBOT_HOME</key><string>/Users/me/.minibot</string>");
		expect(plist).toContain("<key>StandardErrorPath</key><string>/Users/me/.minibot/daemon.log</string>");
	});
});
