// Short, human-readable lines for tool calls, results, and usage.

import type { Usage } from "../runtime/events.ts";
import type { ToolResult } from "../tools/result.ts";
import { preview } from "../util.ts";

/** The argument a reader cares about for well-known tools; JSON otherwise. */
export function describeArgs(tool: string, args: Record<string, unknown>): string {
	const pick = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	const main =
		tool === "exec"
			? pick("command")
			: tool === "web_search" || tool === "search_history"
				? pick("query")
				: tool === "fetch_url"
					? pick("url")
					: tool === "read_skill"
						? pick("name")
						: tool === "remember"
							? pick("content")
							: (pick("path") ?? pick("title") ?? pick("query"));
	if (main !== undefined) return preview(main, 80);
	const json = JSON.stringify(args);
	return json === "{}" ? "" : preview(json, 80);
}

export function describeResult(result: ToolResult): string {
	const tail = result.artifact ? ` [artifact ${result.artifact.id}]` : "";
	return `${result.summary}${tail}`;
}

export function describeUsage(usage: Usage, elapsedMs: number): string {
	const cached = usage.cachedInputTokens > 0 ? `(缓存 ${usage.cachedInputTokens})` : "";
	return `输入 ${usage.inputTokens}${cached} · 输出 ${usage.outputTokens} · ${(elapsedMs / 1000).toFixed(1)}s`;
}

export function approvalQuestion(tool: string, args: Record<string, unknown>): string {
	const detail = describeArgs(tool, args);
	return `允许执行 ${tool}${detail ? `: ${detail}` : ""}?`;
}
