// Compaction: replace older conversation with a model-written summary.
//
// Cut points prefer user-turn boundaries and never split a tool call from its
// results. If one turn alone exceeds the retention target, the cut may fall
// inside it; the summary then also covers that turn's earlier part.
// A summary that fails degrades to a truncated transcript, so compaction
// still frees the budget. Every compaction is one appended entry.

import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { SUMMARY_PROMPT } from "../prompts.ts";
import type { ProjectedMessage } from "../session/projection.ts";
import type { Session, SessionStore } from "../session/store.ts";
import { type ChatMessage, type FileDetails, messageText, toolCalls } from "../session/types.ts";
import { parseToolResult } from "../tools/result.ts";
import { errorMessage, errorName, nowIso, shortId } from "../util.ts";
import { estimateMessageTokens } from "./context.ts";
import { type EventEmitter, usageFrom } from "./events.ts";

const TOOL_RESULT_CHARS = 2_000;
const FALLBACK_TAIL_CHARS = 2_000;

export interface CompactionPlan {
	/** Index (into the projection) of the first message kept verbatim. */
	firstKept: number;
	toSummarize: ProjectedMessage[];
	/** Earlier part of a turn that the cut splits. */
	turnPrefix: ProjectedMessage[];
}

/**
 * Choose what to keep: roughly the last `keepRecentTokens`, rounded to a safe
 * cut point. `start` skips the summary that heads an already compacted session.
 */
export function planCompaction(messages: readonly ProjectedMessage[], keepRecentTokens: number, start: number): CompactionPlan | undefined {
	let total = 0;
	let threshold: number | undefined;
	for (let index = messages.length - 1; index >= start; index--) {
		total += estimateMessageTokens(messages[index].message);
		if (total >= keepRecentTokens) {
			threshold = index;
			break;
		}
	}
	if (threshold === undefined) return undefined;

	let firstKept = -1;
	for (let index = threshold; index < messages.length; index++) {
		if (messages[index].message.role !== "toolResult") {
			firstKept = index;
			break;
		}
	}
	if (firstKept < 0) return undefined;

	let turnStart = -1;
	for (let index = firstKept; index >= start; index--) {
		if (messages[index].message.role === "user") {
			turnStart = index;
			break;
		}
	}
	if (messages[firstKept].message.role !== "user" && turnStart >= 0 && turnTokens(messages, turnStart) <= keepRecentTokens) {
		firstKept = turnStart;
	}

	const splitTurn = messages[firstKept].message.role !== "user" && turnStart >= 0;
	const historyEnd = splitTurn ? turnStart : firstKept;
	if (historyEnd <= start && !splitTurn) return undefined;
	return {
		firstKept,
		toSummarize: messages.slice(start, historyEnd),
		turnPrefix: splitTurn ? messages.slice(turnStart, firstKept) : [],
	};
}

function turnTokens(messages: readonly ProjectedMessage[], turnStart: number): number {
	let end = messages.length;
	for (let index = turnStart + 1; index < messages.length; index++) {
		if (messages[index].message.role === "user") {
			end = index;
			break;
		}
	}
	return messages.slice(turnStart, end).reduce((sum, item) => sum + estimateMessageTokens(item.message), 0);
}

/** A readable transcript for the summarizer; long tool results are cut. */
function transcript(messages: readonly ChatMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		const text = messageText(message).trim();
		if (message.role === "toolResult") {
			const cut = text.length > TOOL_RESULT_CHARS ? `${text.slice(0, TOOL_RESULT_CHARS)}\n\n[... ${text.length - TOOL_RESULT_CHARS} characters truncated]` : text;
			lines.push(`TOOL_RESULT[${message.toolName}]: ${cut}`);
			continue;
		}
		if (text) lines.push(`${message.role.toUpperCase()}: ${text}`);
		for (const call of toolCalls(message)) lines.push(`ASSISTANT_TOOL_CALL: ${call.name}(${JSON.stringify(call.arguments)})`);
	}
	return lines.join("\n");
}

function summaryRequest(plan: CompactionPlan, previousSummary: string | undefined): string {
	const parts: string[] = [];
	if (previousSummary) parts.push(`<previous_summary>\n${previousSummary.trim()}\n</previous_summary>`);
	if (plan.toSummarize.length > 0) parts.push(`<conversation>\n${transcript(plan.toSummarize.map((item) => item.message))}\n</conversation>`);
	if (plan.turnPrefix.length > 0) {
		parts.push(`<split_turn_prefix>\n${transcript(plan.turnPrefix.map((item) => item.message))}\n</split_turn_prefix>`);
	}
	parts.push("请基于以上内容生成或更新结构化 checkpoint 摘要。如果 previous_summary 存在,请把新内容合并进去,不要丢失仍然重要的旧信息。");
	return parts.join("\n\n");
}

/** Files read and modified in `messages`, merged with an earlier compaction's lists. */
export function fileDetails(messages: readonly ChatMessage[], previous: FileDetails | undefined): FileDetails {
	const read = new Set(previous?.readFiles ?? []);
	const modified = new Set(previous?.modifiedFiles ?? []);
	const results = new Map<string, ChatMessage>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
	for (const message of messages) {
		for (const call of toolCalls(message)) {
			const path = typeof call.arguments.path === "string" ? call.arguments.path.trim() : "";
			if ((call.name === "write_file" || call.name === "edit_file") && path) modified.add(path);
			else if (call.name === "read_file" && path) read.add(path);
			else if (call.name === "read_artifact") {
				const result = results.get(call.id);
				const parsed = result ? parseToolResult(messageText(result)) : undefined;
				if (parsed?.ok && parsed.data.kind === "file" && typeof parsed.data.name === "string") read.add(parsed.data.name);
			}
		}
	}
	for (const path of modified) read.delete(path);
	return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() };
}

export function withFileDetails(summary: string, details: FileDetails): string {
	const sections = [summary.trim()];
	if (details.readFiles.length > 0) sections.push(`<read-files>\n${details.readFiles.join("\n")}\n</read-files>`);
	if (details.modifiedFiles.length > 0) sections.push(`<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.join("\n\n");
}

function stripFileDetails(summary: string): string {
	return summary.replace(/\n*<(read|modified)-files>\n[\s\S]*?\n<\/\1-files>/g, "").trim();
}

export interface CompactorDeps {
	store: SessionStore;
	models: Models;
	model: Model<Api>;
	keepRecentTokens: number;
	maxOutputTokens: number;
}

export class Compactor {
	readonly #deps: CompactorDeps;

	constructor(deps: CompactorDeps) {
		this.#deps = deps;
	}

	/**
	 * Summarize everything before a safe cut point and append the compaction.
	 * Returns a status line, or undefined when there is nothing to compact.
	 */
	async compact(session: Session, tokensBefore: number, options: { emitter?: EventEmitter; signal?: AbortSignal } = {}): Promise<string | undefined> {
		const projected = session.projected();
		const previous = session.latestCompaction();
		const start = projected[0]?.isSummary ? 1 : 0;
		const plan = planCompaction(projected, this.#deps.keepRecentTokens, start);
		if (!plan || plan.firstKept <= start) return undefined;

		const previousSummary = previous ? stripFileDetails(previous.summary) : undefined;
		const compacted = [...plan.toSummarize, ...plan.turnPrefix].map((item) => item.message);
		let summary: string;
		let degraded: string | undefined;
		try {
			summary = await this.#summarize(summaryRequest(plan, previousSummary), options);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			degraded = errorName(error);
			summary = [previousSummary, `[自动摘要失败(${degraded}),以下为被压缩上下文的截断原文]`, transcript(compacted).slice(-FALLBACK_TAIL_CHARS)]
				.filter(Boolean)
				.join("\n\n");
		}
		const details = fileDetails(compacted, previous?.details);
		const before = projected.length;
		this.#deps.store.append(session, {
			type: "compaction",
			id: shortId("c"),
			createdAt: nowIso(),
			summary: withFileDetails(summary, details),
			firstKeptId: projected[plan.firstKept].id,
			tokensBefore,
			details,
		});
		const note = degraded ? `(摘要降级为截断: ${degraded})` : "";
		return `已压缩: ${before} -> ${session.projected().length} 条消息,压缩前约 ${tokensBefore} tokens${note}`;
	}

	async #summarize(request: string, options: { emitter?: EventEmitter; signal?: AbortSignal }): Promise<string> {
		const { models, model, maxOutputTokens } = this.#deps;
		const user = { role: "user" as const, content: request, timestamp: Date.now() };
		options.emitter?.emit("compaction.started", {
			model: `${model.provider}/${model.id}`,
			messages: [{ role: "system", content: SUMMARY_PROMPT, timestamp: user.timestamp }, user],
		});
		const started = performance.now();
		const reply = await models.completeSimple(
			model,
			{ systemPrompt: SUMMARY_PROMPT, messages: [user] },
			{ maxTokens: maxOutputTokens, signal: options.signal },
		);
		const elapsedMs = Math.round(performance.now() - started);
		const text = messageText(reply).trim();
		const failed = reply.stopReason === "error" || reply.stopReason === "aborted" || !text;
		const error = failed ? reply.errorMessage ?? "模型没有返回有效摘要。" : null;
		options.emitter?.emit("compaction.completed", { elapsedMs, usage: usageFrom(reply.usage), summary: failed ? null : text, error });
		if (failed) throw new Error(errorMessage(error));
		return text;
	}
}
