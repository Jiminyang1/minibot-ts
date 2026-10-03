import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, readArtifactTool } from "../src/tools/artifacts.ts";
import { dangerReason, execTool } from "../src/tools/exec.ts";
import { editFileTool, globToRegExp, listDirTool, readFileTool, searchFilesTool, writeFileTool } from "../src/tools/files.ts";
import { classifyScriptError, localDateParts, parseRecords } from "../src/tools/macos.ts";
import { MemoryStore } from "../src/tools/memory.ts";
import type { ToolOutput } from "../src/tools/result.ts";
import { parseSkill, SkillRegistry } from "../src/tools/skills.ts";
import type { Tool, ToolContext } from "../src/tools/tool.ts";
import { decodeEntities, htmlToText, parseDuckDuckGo } from "../src/tools/web.ts";
import { sha256 } from "../src/util.ts";
import { SKILLS_DIR } from "../src/runtime/bootstrap.ts";
import { tempDir } from "./helpers.ts";

function context(workspace: string): ToolContext {
	return { sessionId: "s_test", runId: "r_test", workspace, signal: new AbortController().signal };
}

async function call(tool: Tool, args: Record<string, unknown>, workspace: string): Promise<ToolOutput> {
	return tool.execute(args as never, context(workspace));
}

describe("file tools", () => {
	it("refuses paths outside the workspace", async () => {
		const workspace = tempDir();
		const out = await call(readFileTool, { path: "../secret" }, workspace);
		expect(out).toMatchObject({ ok: false, code: "permission_denied" });
	});

	it("reads with a sha and guards overwrites with it", async () => {
		const workspace = tempDir();
		writeFileSync(join(workspace, "a.txt"), "hello");
		const read = await call(readFileTool, { path: "a.txt" }, workspace);
		expect(read).toMatchObject({ ok: true, content: "hello", data: { file_sha256: sha256("hello") } });

		expect(await call(writeFileTool, { path: "a.txt", content: "x" }, workspace)).toMatchObject({ code: "conflict" });
		expect(await call(writeFileTool, { path: "a.txt", content: "x", expected_sha256: "bad" }, workspace)).toMatchObject({ code: "conflict" });
		expect(await call(writeFileTool, { path: "a.txt", content: "x", expected_sha256: sha256("hello") }, workspace)).toMatchObject({ ok: true });
		expect(await call(writeFileTool, { path: "new/dir/b.txt", content: "b" }, workspace)).toMatchObject({ ok: true, data: { created: true } });
		expect(readFileSync(join(workspace, "new/dir/b.txt"), "utf8")).toBe("b");
	});

	it("applies line edits and rejects stale or overlapping ones", async () => {
		const workspace = tempDir();
		const original = "a\nb\nc\n";
		writeFileSync(join(workspace, "f.txt"), original);
		const sha = sha256(original);
		const edit = (edits: unknown[], expected = sha) => call(editFileTool, { path: "f.txt", expected_sha256: expected, edits }, workspace);

		expect(await edit([{ op: "append", new_text: "x" }], "stale")).toMatchObject({ code: "conflict" });
		expect(await edit([{ op: "replace", start_line: 2, end_line: 2, old_text: "B\n", new_text: "z" }])).toMatchObject({ code: "invalid_args" });
		expect(
			await edit([
				{ op: "replace", start_line: 1, end_line: 2, old_text: "a\nb\n", new_text: "x\n" },
				{ op: "replace", start_line: 2, end_line: 3, old_text: "b\nc\n", new_text: "y\n" },
			]),
		).toMatchObject({ code: "invalid_args" });
		const done = await edit([
			{ op: "insert_before", line: 1, new_text: "0\n" },
			{ op: "replace", start_line: 2, end_line: 2, old_text: "b\n", new_text: "B\n" },
			{ op: "insert_after", line: 3, new_text: "d\n" },
		]);
		expect(done).toMatchObject({ ok: true, data: { edits_applied: 3 } });
		expect(readFileSync(join(workspace, "f.txt"), "utf8")).toBe("0\na\nB\nc\nd\n");
	});

	it("lists directories and searches content with a glob", async () => {
		const workspace = tempDir();
		mkdirSync(join(workspace, "src"));
		writeFileSync(join(workspace, "src", "x.ts"), "const needle = 1;\n");
		writeFileSync(join(workspace, "readme.md"), "needle in docs\n");
		expect(await call(listDirTool, {}, workspace)).toMatchObject({ data: { entries: ["src/", "readme.md"] } });
		const found = await call(searchFilesTool, { pattern: "needle", glob: "*.ts" }, workspace);
		expect(found).toMatchObject({ ok: true, data: { total_matches: 1, matches: ["src/x.ts:1: const needle = 1;"] } });
		expect(globToRegExp("**/*.md").test("docs/a/b.md")).toBe(true);
	});
});

describe("exec", () => {
	it("reports failures hidden behind a pipe", async () => {
		const out = await call(execTool, { command: "false | cat" }, tempDir());
		expect(out).toMatchObject({ ok: false, code: "error", data: { exit_code: 1 } });
	});

	it("treats SIGPIPE from an early-closing reader as success", async () => {
		const out = await call(execTool, { command: "yes | head -1" }, tempDir());
		expect(out).toMatchObject({ ok: true, data: { exit_code: 141, stdout: "y\n" } });
	});

	it("refuses dangerous commands", async () => {
		expect(dangerReason("rm -rf /")).toBeDefined();
		expect(dangerReason("ls -la")).toBeUndefined();
		const out = await call(execTool, { command: "sudo -i" }, tempDir());
		expect(out).toMatchObject({ code: "permission_denied" });
	});
});

describe("artifacts", () => {
	it("stores long output and pages through it", async () => {
		const home = tempDir();
		const store = new ArtifactStore(home);
		const long = "x".repeat(30_000);
		const result = store.materialize({ ok: true, code: "success", summary: "读取完成。", content: long }, "s_test");
		expect(result).toMatchObject({ truncated: true, artifact: { kind: "text" } });
		expect((result.data.preview as string).length).toBe(2_000);
		const page = await readArtifactTool(store).execute({ artifact_id: result.artifact?.id ?? "", offset: 0 } as never, context(home));
		expect(page).toMatchObject({ ok: true, data: { returned_chars: 12_000, next_offset: 12_000, has_more: true } });
	});

	it("inlines short output", () => {
		const store = new ArtifactStore(tempDir());
		expect(store.materialize({ ok: true, code: "success", summary: "ok", content: "short" }, "s_test")).toMatchObject({
			data: { content: "short" },
			artifact: null,
		});
	});
});

describe("memory", () => {
	it("never reuses an id", () => {
		const store = new MemoryStore(join(tempDir(), "memory.json"));
		const first = store.add("喜欢咖啡");
		store.delete(first.id);
		const second = store.add("住在上海");
		expect(first.id).toBe("mem_1");
		expect(second.id).toBe("mem_2");
		expect(store.list().map((item) => item.content)).toEqual(["住在上海"]);
		expect(store.clear()).toBe(1);
	});
});

describe("skills", () => {
	it("parses frontmatter with a tool list", () => {
		const skill = parseSkill("---\nname: demo\ndescription: \"a demo\"\ntools:\n  - read_file\n  - exec\n---\nbody text\n");
		expect(skill).toEqual({ name: "demo", description: "a demo", tools: ["read_file", "exec"], body: "body text" });
	});

	it("loads the bundled skills", () => {
		const warnings: string[] = [];
		const registry = SkillRegistry.fromDirectory(SKILLS_DIR, (message) => warnings.push(message));
		expect(warnings).toEqual([]);
		expect(registry.skills.map((skill) => skill.name).sort()).toEqual(["calendar", "drawio", "mail", "notes", "reminders"]);
		expect(registry.visible(() => false)).toEqual([]);
	});
});

describe("web parsing", () => {
	it("extracts DuckDuckGo results and unwraps redirects", () => {
		const html =
			'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example &amp; Co</a>' +
			'<a class="result__snippet" href="x">A <b>snippet</b></a>';
		expect(parseDuckDuckGo(html)).toEqual([{ title: "Example & Co", url: "https://example.com/a", snippet: "A snippet" }]);
	});

	it("turns HTML into readable text", () => {
		const { title, text } = htmlToText("<html><head><title>T</title></head><body><nav>menu</nav><p>Hello&nbsp;<b>world</b></p><script>x()</script><p>Two</p></body></html>");
		expect(title).toBe("T");
		expect(text).toBe("Hello world\nTwo");
		expect(decodeEntities("&#x4e2d;&#25991;")).toBe("中文");
	});
});

describe("macOS bridge helpers", () => {
	it("parses records and classifies script errors", () => {
		const raw = ["1", "a"].join(String.fromCharCode(31)) + String.fromCharCode(30) + ["2", "b"].join(String.fromCharCode(31));
		expect(parseRecords(raw, ["id", "name"] as const)).toEqual([
			{ id: "1", name: "a" },
			{ id: "2", name: "b" },
		]);
		expect(classifyScriptError("execution error: Not authorized to send Apple events (-1743)")).toBe("permission_denied");
		expect(classifyScriptError("Can’t get calendar \"x\". (-1728)")).toBe("not_found");
		expect(localDateParts("2026-04-20T09:05", "start_at")).toEqual(["2026", "4", "20", "9", "5", "0"]);
		expect(() => localDateParts("tomorrow", "start_at")).toThrow();
	});
});

it("does not leave files behind when a write is refused", async () => {
	const workspace = tempDir();
	await call(writeFileTool, { path: "../x", content: "x" }, workspace);
	expect(existsSync(join(workspace, "..", "x"))).toBe(false);
});
