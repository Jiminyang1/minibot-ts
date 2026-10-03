// What a tool produces (ToolOutput) and what the model receives (ToolResult).
//
// A tool returns semantic output; large text goes in `content`. The runtime
// materializes it: short content is inlined into `data.content`, long content
// becomes an artifact the model can page through with read_artifact.

export type ToolCode =
	| "success"
	| "noop"
	| "invalid_args"
	| "not_found"
	| "permission_denied"
	| "timeout"
	| "denied"
	| "conflict"
	| "interrupted"
	| "error";

export type ArtifactKind = "text" | "json" | "file";

export interface ArtifactRef {
	id: string;
	kind: ArtifactKind;
	name: string | null;
}

export interface ToolOutput {
	ok: boolean;
	code: ToolCode;
	summary: string;
	/** Structured fields for the model; keep it small (see MAX_DATA_CHARS). */
	data?: Record<string, unknown>;
	/** Body text that may be large. */
	content?: string;
	contentKind?: ArtifactKind;
	contentName?: string;
	truncated?: boolean;
}

/** The envelope the model sees, serialized as the tool result text. */
export interface ToolResult {
	ok: boolean;
	code: ToolCode;
	summary: string;
	data: Record<string, unknown>;
	artifact: ArtifactRef | null;
	truncated: boolean;
}

export const MAX_DATA_CHARS = 24_000;

export function success(summary: string, extra: Omit<ToolOutput, "ok" | "code" | "summary"> = {}): ToolOutput {
	return { ok: true, code: "success", summary, ...extra };
}

export function failure(
	code: Exclude<ToolCode, "success" | "noop">,
	summary: string,
	extra: Omit<ToolOutput, "ok" | "code" | "summary"> = {},
): ToolOutput {
	return { ok: false, code, summary, ...extra };
}

export function noop(summary: string, data: Record<string, unknown> = {}): ToolOutput {
	return { ok: true, code: "noop", summary, data };
}

export function toolResultText(result: ToolResult): string {
	return JSON.stringify(result);
}

/** Read an envelope back from a tool result text; undefined for plain text. */
export function parseToolResult(text: string): ToolResult | undefined {
	try {
		const value = JSON.parse(text) as Partial<ToolResult>;
		if (typeof value?.ok === "boolean" && typeof value.code === "string" && typeof value.summary === "string") {
			return {
				ok: value.ok,
				code: value.code,
				summary: value.summary,
				data: value.data ?? {},
				artifact: value.artifact ?? null,
				truncated: value.truncated ?? false,
			};
		}
	} catch {
		// Plain text produced by the agent loop itself (unknown tool, bad args).
	}
	return undefined;
}

/** The result recorded for a tool call whose outcome was never written. */
export function interruptedResult(toolName: string): ToolResult {
	return {
		ok: false,
		code: "interrupted",
		summary:
			`工具 ${toolName} 没有记录到结果:运行被取消或进程中断。` +
			"它可能未执行、部分执行或已执行完毕,副作用未知;重试有副作用的操作前请先确认当前状态。",
		data: { tool: toolName },
		artifact: null,
		truncated: false,
	};
}
