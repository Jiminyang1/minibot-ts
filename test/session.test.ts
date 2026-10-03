import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { project } from "../src/session/projection.ts";
import { SessionNotFoundError, SessionStore } from "../src/session/store.ts";
import type { SessionEntry } from "../src/session/types.ts";
import { parseToolResult } from "../src/tools/result.ts";
import { tempDir } from "./helpers.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(text: string, calls: { id: string; name: string }[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...calls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: {} }))],
		api: "faux",
		provider: "faux",
		model: "m",
		usage,
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp: 1,
	};
}

function result(id: string, name: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "{}" }], isError: false, timestamp: 1 };
}

let counter = 0;
function entry(message: UserMessage | AssistantMessage | ToolResultMessage): SessionEntry {
	counter += 1;
	return { type: "message", id: `m${counter}`, createdAt: new Date(counter * 1000).toISOString(), message };
}

describe("projection", () => {
	it("keeps complete tool blocks as they are", () => {
		const entries = [entry(user("q")), entry(assistant("", [{ id: "c1", name: "read_file" }])), entry(result("c1", "read_file")), entry(assistant("a"))];
		expect(project(entries).map((item) => item.message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("hides an incomplete block at the tail: it may still be running", () => {
		const entries = [entry(user("q")), entry(assistant("", [{ id: "c1", name: "exec" }]))];
		expect(project(entries).map((item) => item.message.role)).toEqual(["user"]);
	});

	it("fills missing results with interrupted once something follows", () => {
		const entries = [
			entry(user("q")),
			entry(assistant("", [{ id: "c1", name: "exec" }, { id: "c2", name: "read_file" }])),
			entry(result("c2", "read_file")),
			entry(user("again")),
		];
		const projected = project(entries);
		expect(projected.map((item) => item.message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user"]);
		const filled = projected[2].message as ToolResultMessage;
		expect(filled.toolCallId).toBe("c1");
		expect(parseToolResult((filled.content[0] as { text: string }).text)?.code).toBe("interrupted");
		expect((projected[3].message as ToolResultMessage).toolCallId).toBe("c2");
	});

	it("replaces history before the first kept entry with the summary", () => {
		const first = entry(user("old"));
		const kept = entry(user("kept"));
		const entries: SessionEntry[] = [
			first,
			entry(assistant("old answer")),
			kept,
			entry(assistant("kept answer")),
			{ type: "compaction", id: "c1", createdAt: new Date().toISOString(), summary: "S", firstKeptId: kept.id, tokensBefore: 9, details: { readFiles: [], modifiedFiles: [] } },
			entry(user("new")),
		];
		const projected = project(entries);
		expect(projected[0].isSummary).toBe(true);
		expect(projected.slice(1).map((item) => item.id)).toEqual([kept.id, entries[3].id, entries[5].id]);
	});
});

describe("SessionStore", () => {
	function store() {
		const home = tempDir();
		return new SessionStore({ dir: join(home, "sessions"), currentPath: join(home, "current"), workspace: "/work" });
	}

	it("appends, reloads, and lists sessions", () => {
		const sessions = store();
		const session = sessions.createCurrent();
		sessions.appendMessage(session, user("你好世界"));
		sessions.appendMessage(session, assistant("hi"));
		const loaded = sessions.load(session.id);
		expect(loaded?.messages().length).toBe(2);
		expect(loaded?.meta).toMatchObject({ title: "你好世界", messageCount: 2, workspace: "/work" });
		expect(sessions.list().map((meta) => meta.id)).toEqual([session.id]);
		expect(sessions.currentId()).toBe(session.id);
	});

	it("survives a torn last line", () => {
		const sessions = store();
		const session = sessions.create();
		sessions.appendMessage(session, user("one"));
		appendFileSync(join(sessions.sessionDir(session.id), "entries.jsonl"), '{"type":"mess');
		expect(sessions.load(session.id)?.messages().length).toBe(1);
	});

	it("resumes the current session, then the latest non-empty one", () => {
		const sessions = store();
		const fresh = sessions.startup();
		expect(fresh.resumed).toBe(false);
		sessions.appendMessage(fresh.session, user("x"));
		expect(sessions.startup()).toMatchObject({ resumed: true, session: { meta: { id: fresh.session.id } } });
		sessions.delete(fresh.session.id);
		expect(sessions.currentId()).toBeUndefined();
	});

	it("resolves run targets", () => {
		const sessions = store();
		const created = sessions.resolve(undefined);
		expect(sessions.resolve("current").id).toBe(created.id);
		expect(() => sessions.resolve("s_missing")).toThrow(SessionNotFoundError);
		expect(() => sessions.sessionDir("../escape")).toThrow();
	});
});
