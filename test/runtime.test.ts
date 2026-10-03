import type { AssistantMessage, JsonObject, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { mcpResultToOutput, mcpToolName, parseMcpConfig } from "../src/mcp/host.ts";
import { fileDetails, planCompaction, withFileDetails } from "../src/runtime/compaction.ts";
import { Budget } from "../src/runtime/context.ts";
import type { ProjectedMessage } from "../src/session/projection.ts";
import { Session } from "../src/session/store.ts";
import type { ChatMessage, SessionEntry } from "../src/session/types.ts";

const usage = (input = 0, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });
const reply = (text: string, calls: { id: string; name: string; arguments?: JsonObject }[] = [], tokens = usage()): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }, ...calls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.arguments ?? {} }))],
	api: "faux",
	provider: "faux",
	model: "m",
	usage: tokens,
	stopReason: calls.length ? "toolUse" : "stop",
	timestamp: 0,
});
const result = (id: string, name: string, text = "{}"): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 0 });
const projected = (messages: ChatMessage[]): ProjectedMessage[] => messages.map((message, index) => ({ id: `m${index}`, message }));

describe("compaction planning", () => {
	const long = "字".repeat(100); // about 100 tokens each

	it("keeps recent turns and cuts at a user message", () => {
		const plan = planCompaction(projected([user(long), reply(long), user(long), reply(long), user(long), reply(long)]), 150, 0);
		expect(plan?.firstKept).toBe(4);
		expect(plan?.toSummarize.map((item) => item.id)).toEqual(["m0", "m1", "m2", "m3"]);
		expect(plan?.turnPrefix).toEqual([]);
	});

	it("never cuts at a tool result, and splits an oversized turn", () => {
		const messages = projected([
			user("old"),
			reply("ok"),
			user(long),
			reply(long, [{ id: "c1", name: "read_file" }]),
			result("c1", "read_file", long),
			reply(long),
		]);
		const plan = planCompaction(messages, 150, 0);
		expect(messages[plan?.firstKept ?? 0].message.role).not.toBe("toolResult");
		expect(plan?.turnPrefix.length).toBeGreaterThan(0);
		expect(plan?.toSummarize.map((item) => item.id)).toEqual(["m0", "m1"]);
	});

	it("has nothing to do when everything fits", () => {
		expect(planCompaction(projected([user("a"), reply("b")]), 1_000, 0)).toBeUndefined();
	});

	it("tracks files read and modified, merged with earlier lists", () => {
		const details = fileDetails(
			[reply("", [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }, { id: "2", name: "edit_file", arguments: { path: "b.ts" } }, { id: "3", name: "read_file", arguments: { path: "b.ts" } }])],
			{ readFiles: ["old.ts"], modifiedFiles: [] },
		);
		expect(details).toEqual({ readFiles: ["a.ts", "old.ts"], modifiedFiles: ["b.ts"] });
		expect(withFileDetails("S", details)).toBe("S\n\n<read-files>\na.ts\nold.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>");
	});
});

describe("Budget", () => {
	const meta = { id: "s", title: "t", createdAt: "", updatedAt: "", workspace: "/", messageCount: 0 };
	const entry = (message: ChatMessage, id: string): SessionEntry => ({ type: "message", id, createdAt: "", message });

	it("starts from the provider's measurement when there is one", () => {
		const budget = new Budget({ contextWindow: 10_000, maxOutputTokens: 1_000, compactThreshold: undefined });
		expect(budget.hardLimit).toBe(9_000);
		expect(budget.compactAt).toBe(9_000);
		const measured = new Session(meta, [entry(user("q"), "1"), entry(reply("a", [], usage(500, 20)), "2"), entry(user("12345678"), "3")]);
		expect(budget.estimate(measured, 999)).toBe(520 + 2 + 4);
		const fresh = new Session(meta, [entry(user("12345678"), "1")]);
		expect(budget.estimate(fresh, 100)).toBe(100 + 2 + 4);
	});

	it("rejects a threshold above the hard limit", () => {
		expect(() => new Budget({ contextWindow: 1_000, maxOutputTokens: 100, compactThreshold: 950 })).toThrow();
		expect(() => new Budget({ contextWindow: 1_000, maxOutputTokens: 1_000, compactThreshold: undefined })).toThrow();
	});
});

describe("MCP host helpers", () => {
	it("parses servers, substitutes ${VAR}, and skips bad entries", () => {
		const { servers, warnings } = parseMcpConfig(
			{
				servers: {
					local: { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "${MY_TOKEN}" } },
					remote: { url: "https://x/mcp", headers: { Authorization: "Bearer ${MY_TOKEN}" }, trusted: true, timeoutSeconds: 5 },
					broken: { args: [] },
					"bad name": { command: "x" },
					missing: { command: "x", env: { A: "${NOT_SET}" } },
				},
			},
			{ MY_TOKEN: "t0k" },
		);
		expect(servers.map((server) => server.name)).toEqual(["local", "remote"]);
		expect(servers[0].transport).toMatchObject({ type: "stdio", env: { TOKEN: "t0k" } });
		expect(servers[1]).toMatchObject({ trusted: true, timeoutMs: 5_000, transport: { headers: { Authorization: "Bearer t0k" } } });
		expect(warnings).toHaveLength(3);
		expect(parseMcpConfig({ nope: 1 }, {}).warnings).toHaveLength(1);
	});

	it("names tools within provider limits and converts results", () => {
		expect(mcpToolName("my.server", "tool/with spaces")).toBe("mcp__my_server__tool_with_spaces");
		expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
		expect(mcpResultToOutput("s.t", { content: [{ type: "text", text: "hi" }] })).toMatchObject({ ok: true, content: "hi", contentKind: "text" });
		expect(mcpResultToOutput("s.t", { content: [], structuredContent: { a: 1 }, isError: true })).toMatchObject({ ok: false, code: "error", contentKind: "json" });
	});
});
