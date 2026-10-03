import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { RunCancelledError } from "../src/runtime/agent-session.ts";
import { messageText } from "../src/session/types.ts";
import { parseToolResult } from "../src/tools/result.ts";
import { sha256, sleep } from "../src/util.ts";
import { eventTypes, testRuntime } from "./helpers.ts";

describe("AgentSession", () => {
	it("answers, persists the turn, and logs the run", async () => {
		const { runtime, faux, events } = await testRuntime();
		faux.setResponses([fauxAssistantMessage("你好!")]);
		const outcome = await runtime.session.prompt(undefined, "hi", { source: "cli" });

		expect(outcome.reply).toBe("你好!");
		const session = runtime.store.load(outcome.sessionId);
		expect(session?.messages().map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(session?.meta.title).toBe("hi");
		expect(eventTypes(events)).toEqual([
			"run.started",
			"context.usage",
			"model.started",
			"model.completed",
			"message.completed",
			"run.completed",
		]);
		const record = JSON.parse(readFileSync(runtime.paths.runs, "utf8").trim());
		expect(record).toMatchObject({ status: "completed", llmCalls: 1, toolCalls: 0, source: "cli" });
	});

	it("sends the system prompt and stamps the latest user message", async () => {
		const { runtime, faux } = await testRuntime();
		let seen: { system: string; tools: string[]; last: string } | undefined;
		faux.setResponses([
			(context) => {
				const system = context.messages[0];
				const last = context.messages.at(-1);
				seen = {
					system: system.role === "system" && typeof system.content === "string" ? system.content : "",
					tools: system.role === "system" ? (system.toolsAdded ?? []).map((tool) => tool.name) : [],
					last: last && last.role === "user" ? (typeof last.content === "string" ? last.content : "") : "",
				};
				return fauxAssistantMessage("ok");
			},
		]);
		const outcome = await runtime.session.prompt(undefined, "现在几点", { source: "cli" });
		expect(seen?.system).toContain("## Local Time Context");
		// Tools are declared on the leading system message, or the model never sees them.
		expect(seen?.tools).toContain("read_file");
		expect(seen?.last).toMatch(/^现在几点\n\n\[当前本地时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2} /);
		// The stamp is request-only: the session keeps what the user typed.
		const stored = runtime.store.load(outcome.sessionId)?.messages()[0];
		expect(stored && messageText(stored)).toBe("现在几点");
	});

	it("runs a tool and feeds the envelope back", async () => {
		const { runtime, faux, events } = await testRuntime();
		writeFileSync(join(runtime.config.workspace, "note.txt"), "hello file");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_file", { path: "note.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("文件内容是 hello file"),
		]);
		const outcome = await runtime.session.prompt(undefined, "读 note.txt", { source: "cli" });

		expect(outcome.reply).toContain("hello file");
		const messages = runtime.store.load(outcome.sessionId)?.messages() ?? [];
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const envelope = parseToolResult(messageText(messages[2]));
		expect(envelope).toMatchObject({ ok: true, code: "success", data: { path: "note.txt", content: "hello file" } });
		const completed = events.find((event) => event.type === "tool.completed");
		expect(completed?.payload).toMatchObject({ tool: "read_file", result: { ok: true } });
	});

	it("asks before sensitive tools and records a denial", async () => {
		const requests: string[] = [];
		const { runtime, faux, events } = await testRuntime({}, {
			approval: async (request) => {
				requests.push(request.tool);
				return false;
			},
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "x.txt", content: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("好的,没有写入。"),
		]);
		await runtime.session.prompt(undefined, "写 x.txt", { source: "cli" });

		expect(requests).toEqual(["write_file"]);
		expect(existsSync(join(runtime.config.workspace, "x.txt"))).toBe(false);
		const failed = events.find((event) => event.type === "tool.failed");
		expect(failed?.payload).toMatchObject({ result: { code: "denied" } });
		expect(eventTypes(events)).toContain("approval.required");
	});

	it("denies sensitive tools when no approval channel exists", async () => {
		const { runtime, faux, events } = await testRuntime();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("exec", { command: "echo hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("无法执行。"),
		]);
		await runtime.session.prompt(undefined, "run", { source: "cli" });
		const resolved = events.find((event) => event.type === "approval.resolved");
		expect(resolved?.payload).toMatchObject({ approved: false, auto: true });
	});

	it("edits a file with the sha from a previous read", async () => {
		const { runtime, faux } = await testRuntime({ approval: "always" });
		const path = join(runtime.config.workspace, "a.txt");
		writeFileSync(path, "one\ntwo\n");
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit_file", {
						path: "a.txt",
						expected_sha256: sha256("one\ntwo\n"),
						edits: [{ op: "replace", start_line: 2, end_line: 2, old_text: "two\n", new_text: "TWO\n" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("改好了。"),
		]);
		await runtime.session.prompt(undefined, "改第二行", { source: "cli" });
		expect(readFileSync(path, "utf8")).toBe("one\nTWO\n");
	});

	it("cancels while waiting for approval", async () => {
		let release: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { runtime, faux, events } = await testRuntime({}, {
			approval: (_request, signal) =>
				new Promise((resolve) => {
					release?.();
					signal.addEventListener("abort", () => resolve(false), { once: true });
				}),
		});
		faux.setResponses([fauxAssistantMessage([fauxToolCall("exec", { command: "rm x" })], { stopReason: "toolUse" })]);
		const run = runtime.session.prompt(undefined, "删除", { source: "cli", runId: "r_test_cancel" });
		await waiting;
		expect(runtime.session.abort("r_test_cancel")).toBe(true);
		await expect(run).rejects.toBeInstanceOf(RunCancelledError);
		expect(events.at(-1)?.type).toBe("run.cancelled");
		// The session stays well-formed: every call has a result.
		const session = runtime.store.load(events[0].sessionId);
		expect(session?.messages().map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(runtime.session.isBusy()).toBe(false);
	});

	it("stops after the request limit with a fixed reply", async () => {
		const { runtime, faux } = await testRuntime({ maxIterations: 2 });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("list_dir", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("list_dir", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("never reached"),
		]);
		const outcome = await runtime.session.prompt(undefined, "loop", { source: "cli" });
		expect(outcome.reply).toContain("上限");
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("fails on an empty reply", async () => {
		const { runtime, faux, events } = await testRuntime();
		faux.setResponses([fauxAssistantMessage([fauxText("")])]);
		await expect(runtime.session.prompt(undefined, "?", { source: "cli" })).rejects.toThrow("空回复");
		expect(events.at(-1)?.type).toBe("run.failed");
	});

	it("retries a call that failed before any output", async () => {
		const { runtime, faux, events } = await testRuntime({ maxRetries: 2 });
		faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("恢复了"),
		]);
		const started = Date.now();
		const outcome = await runtime.session.prompt(undefined, "hi", { source: "cli" });
		expect(outcome.reply).toBe("恢复了");
		expect(eventTypes(events)).toContain("model.retrying");
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		const session = runtime.store.load(outcome.sessionId);
		expect(session?.messages().map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("does not retry a failure that is not transient", async () => {
		const { runtime, faux } = await testRuntime();
		faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid request" })]);
		await expect(runtime.session.prompt(undefined, "hi", { source: "cli" })).rejects.toThrow("400 invalid request");
	});

	it("refuses a second turn on a busy session", async () => {
		const { runtime, faux } = await testRuntime();
		faux.setResponses([
			async () => {
				await sleep(100);
				return fauxAssistantMessage("slow");
			},
		]);
		const session = runtime.store.createCurrent();
		const first = runtime.session.prompt(session.id, "a", { source: "cli" });
		await expect(runtime.session.prompt(session.id, "b", { source: "cli" })).rejects.toThrow("已有运行中的 turn");
		await first;
	});

	it("compacts when the request grows past the threshold", async () => {
		const { runtime, faux, events } = await testRuntime({ compactThreshold: 600, keepRecentTokens: 100 });
		const long = "很长的内容".repeat(60);
		// Answer summary requests with a summary and everything else with a long reply.
		const respond = (context: { messages: { role: string; content: unknown }[] }) => {
			const system = context.messages[0];
			const isSummary = typeof system?.content === "string" && system.content.includes("上下文摘要助手");
			return fauxAssistantMessage(isSummary ? "## 目标\n讨论长内容" : `回答 ${long}`);
		};
		faux.setResponses(Array.from({ length: 8 }, () => respond));
		const first = await runtime.session.prompt(undefined, `问题一 ${long}`, { source: "cli" });
		await runtime.session.prompt(first.sessionId, `问题二 ${long}`, { source: "cli" });
		await runtime.session.prompt(first.sessionId, "问题三", { source: "cli" });

		expect(eventTypes(events)).toContain("context.compacted");
		expect(eventTypes(events)).toContain("compaction.completed");
		const session = runtime.store.load(first.sessionId);
		expect(session?.latestCompaction()?.summary).toContain("讨论长内容");
		expect(session?.projected()[0].isSummary).toBe(true);
		expect(session?.messages().at(-1)?.role).toBe("assistant");
	});
});
