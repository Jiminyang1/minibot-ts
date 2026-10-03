// Run one golden case as a real turn in an isolated sandbox.
//
// The production runtime runs against the real model (same system prompt,
// skills, loop, compaction, and tool schemas). Anything with side effects is
// swapped first:
//   - state lives in a temp MINIBOT_HOME; file tools are real but rooted at a
//     temp workspace seeded per case;
//   - the macOS tools are stand-ins with the real names and schemas that
//     return canned results; a case can script {"sequence": [...]} (later calls
//     reuse the last entry; {"error": "..."} fails that call);
//   - exec, web_search, and fetch_url never run.
// Stand-ins never mention the sandbox: a model that knows it is being tested
// behaves differently.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { buildRuntime } from "../runtime/bootstrap.ts";
import type { RuntimeEvent } from "../runtime/events.ts";
import { resolveInWorkspace } from "../tools/files.ts";
import { classifyScriptError, macosTools } from "../tools/macos.ts";
import { MemoryStore } from "../tools/memory.ts";
import { failure, success, type ToolOutput } from "../tools/result.ts";
import type { Tool, ToolRegistry } from "../tools/tool.ts";
import { execTool } from "../tools/exec.ts";
import { fetchUrlTool, webSearchTool } from "../tools/web.ts";
import { errorMessage, errorName } from "../util.ts";
import type { CaseOutput, ToolCallRecord } from "./scoring.ts";

export interface CaseInput {
	prompt: string;
	files?: Record<string, string>;
	memory?: string[];
	toolResults?: Record<string, unknown>;
	approval?: "approve" | "deny";
}

const MAX_SNAPSHOT_CHARS = 20_000;

/** A tool with the real name and schema whose result comes from the case. */
function standIn(tool: Tool, run: (args: Record<string, unknown>) => ToolOutput): Tool {
	return { ...tool, execute: (args) => run(args as Record<string, unknown>) };
}

function cannedMacos(tool: Tool, results: Record<string, unknown>): Tool {
	let calls = 0;
	return standIn(tool, (args) => {
		let payload = results[tool.name];
		if (payload && typeof payload === "object" && "sequence" in payload) {
			const sequence = (payload as { sequence: unknown[] }).sequence;
			payload = sequence[Math.min(calls, sequence.length - 1)];
		}
		calls += 1;
		if (payload && typeof payload === "object" && "error" in payload) {
			const message = String((payload as { error: unknown }).error);
			const code = classifyScriptError(message);
			return failure(code === "success" || code === "noop" ? "error" : code, message);
		}
		return success("已完成。", { data: (payload ?? { ...args }) as Record<string, unknown> });
	});
}

function installStandIns(registry: ToolRegistry, results: Record<string, unknown>): void {
	for (const tool of macosTools) registry.register(cannedMacos(tool, results));
	registry.register(
		standIn(execTool, (args) => {
			const canned = results.exec;
			// Like a command that succeeds silently, e.g. `open -a Reminders`.
			return success("命令已执行,退出码 0。", {
				data: { command: args.command, exit_code: 0, ...(canned && typeof canned === "object" ? canned : { stdout: "", stderr: "" }) },
			});
		}),
	);
	registry.register(
		standIn(webSearchTool, (args) => {
			const items = Array.isArray(results.web_search) ? results.web_search : [];
			return success(`找到 ${items.length} 条网页结果。`, { data: { query: args.query, allowed_domains: [], results: items } });
		}),
	);
	registry.register(
		standIn(fetchUrlTool, (args) => {
			const pages = (results.fetch_url ?? {}) as Record<string, string>;
			const page = pages[String(args.url)];
			// Look like an ordinary failure, not like a sandbox.
			if (page === undefined) return failure("error", "抓取失败: HTTP 503 Service Unavailable", { data: { url: args.url } });
			return success(`已抓取网页 ${args.url}(${page.length} 字符)。`, { data: { url: args.url, total_chars: page.length }, content: page });
		}),
	);
}

function snapshot(workspace: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else files[relative(workspace, path)] = readFileSync(path, "utf8").slice(0, MAX_SNAPSHOT_CHARS);
		}
	};
	walk(workspace);
	return files;
}

/** Reduce a run's events to what the scorers need. */
function summarizeEvents(events: RuntimeEvent[]): Pick<CaseOutput, "toolCalls" | "skillsRead" | "modelCalls" | "inputTokens" | "outputTokens"> {
	const calls = new Map<string, ToolCallRecord>();
	let modelCalls = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	for (const event of events) {
		if (event.type === "tool.started") {
			calls.set(event.payload.toolCallId, { name: event.payload.tool, args: event.payload.args, ok: null, code: null, approved: null });
		} else if (event.type === "tool.completed" || event.type === "tool.failed") {
			const call = calls.get(event.payload.toolCallId);
			if (call) Object.assign(call, { ok: event.payload.result.ok, code: event.payload.result.code });
		} else if (event.type === "approval.resolved") {
			const call = calls.get(event.payload.toolCallId);
			if (call) call.approved = event.payload.approved;
		} else if (event.type === "model.completed" || event.type === "compaction.completed") {
			modelCalls += 1;
			inputTokens += event.payload.usage?.inputTokens ?? 0;
			outputTokens += event.payload.usage?.outputTokens ?? 0;
		}
	}
	const toolCalls = [...calls.values()];
	return {
		toolCalls,
		skillsRead: toolCalls.filter((call) => call.name === "read_skill").map((call) => String(call.args.name)),
		modelCalls,
		inputTokens,
		outputTokens,
	};
}

export async function runCase(input: CaseInput, config: Config, models?: Models): Promise<CaseOutput> {
	const root = mkdtempSync(join(tmpdir(), "minibot-eval-"));
	try {
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		for (const [path, content] of Object.entries(input.files ?? {})) {
			const target = resolveInWorkspace(workspace, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content, "utf8");
		}
		const memory = new MemoryStore(join(home, "memory.json"));
		for (const fact of input.memory ?? []) memory.add(fact);

		const approve = (input.approval ?? "approve") === "approve";
		// Evals decide approvals themselves; never inherit "always".
		const runtime = await buildRuntime({ ...config, home, workspace, approval: "ask" }, { mcp: false, models, approval: async () => approve });
		installStandIns(runtime.tools, input.toolResults ?? {});

		const events: RuntimeEvent[] = [];
		const started = performance.now();
		let reply: string | null = null;
		let error: string | null = null;
		try {
			reply = (await runtime.session.prompt(undefined, input.prompt, { source: "eval", onEvent: (event) => events.push(event) })).reply;
		} catch (failure) {
			// A failed run is a result to score, not a crash.
			error = `${errorName(failure)}: ${errorMessage(failure)}`;
		} finally {
			await runtime.close();
		}
		return {
			reply,
			error,
			elapsedS: Math.round((performance.now() - started) / 10) / 100,
			...summarizeEvents(events),
			files: snapshot(workspace),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
