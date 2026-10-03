import { writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { cronNext, nextRun, parseCron } from "../src/scheduler/schedule.ts";
import { HEARTBEAT_OK, Scheduler } from "../src/scheduler/scheduler.ts";
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

async function scheduled(reply: string) {
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
	});
	return { ...test, scheduler, notes };
}

describe("scheduler", () => {
	it("fires a due cron task in a new session and notifies", async () => {
		const { runtime, scheduler, notes } = await scheduled("今日简报已生成");
		const task = runtime.schedule.add({ title: "简报", prompt: "生成简报", kind: "cron", expr: "* * * * *", workspace: "/w" });
		const now = new Date(Date.parse(task.createdAt) + 90_000);
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

	it("keeps a quiet heartbeat quiet and reuses its session", async () => {
		const { runtime, scheduler, notes } = await scheduled(`一切正常 ${HEARTBEAT_OK}`);
		writeFileSync(runtime.paths.heartbeat, "# 注释\n- 检查邮件\n");
		const task = runtime.schedule.add({ title: "巡逻", prompt: "", kind: "heartbeat", expr: "* * * * *", workspace: "/w" });
		const first = new Date(Date.parse(task.createdAt) + 90_000);
		await scheduler.tick(first);
		await scheduler.tick(new Date(first.getTime() + 60_000));
		const updated = runtime.schedule.get(task.id);
		expect(updated?.lastStatus).toBe("ok-quiet");
		expect(notes).toEqual([]);
		const session = runtime.store.load(updated?.sessionId ?? "");
		expect(session?.turnCount()).toBe(2);
	});

	it("notifies when the heartbeat finds something", async () => {
		const { runtime, scheduler, notes } = await scheduled("有一封重要邮件需要回复");
		const task = runtime.schedule.add({ title: "巡逻", prompt: "", kind: "heartbeat", expr: "* * * * *", workspace: "/w" });
		await scheduler.tick(new Date(Date.parse(task.createdAt) + 90_000));
		expect(runtime.schedule.get(task.id)?.lastStatus).toBe("attention");
		expect(notes[0]).toContain("重要邮件");
	});
});
