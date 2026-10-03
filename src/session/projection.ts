// Project the append-only log into the conversation the model sees.
//
// - The newest compaction replaces everything before its first kept entry
//   with a summary message.
// - Every tool call block stays well-formed: a block missing results at the
//   tail may still be running and is left out; once anything follows it, the
//   run that made it is over, so each missing result becomes an
//   `interrupted` result (effect unknown). Nothing is rewritten on disk.

import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { interruptedResult, toolResultText } from "../tools/result.ts";
import type { ChatMessage, CompactionEntry, SessionEntry } from "./types.ts";
import { toolCalls } from "./types.ts";

export interface ProjectedMessage {
	/** Entry id, or a synthetic id for the summary and filled-in results. */
	id: string;
	message: ChatMessage;
	/** True for the summary that stands in for compacted history. */
	isSummary?: boolean;
}

export const SUMMARY_OPEN = "<conversation-summary>";
export const SUMMARY_CLOSE = "</conversation-summary>";

export function summaryMessage(summary: string, timestamp: number): UserMessage {
	return {
		role: "user",
		content: `${SUMMARY_OPEN}\n以下是更早对话的摘要,由系统生成,不是用户的新输入。\n\n${summary.trim()}\n${SUMMARY_CLOSE}`,
		timestamp,
	};
}

export function latestCompaction(entries: readonly SessionEntry[]): { entry: CompactionEntry; index: number } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "compaction") return { entry, index };
	}
	return undefined;
}

export function project(entries: readonly SessionEntry[]): ProjectedMessage[] {
	const compaction = latestCompaction(entries);
	const visible: ProjectedMessage[] = [];
	if (compaction === undefined) {
		for (const entry of entries) {
			if (entry.type === "message") visible.push({ id: entry.id, message: entry.message });
		}
		return repairToolBlocks(visible);
	}

	const { entry, index } = compaction;
	visible.push({
		id: `${entry.id}:summary`,
		message: summaryMessage(entry.summary, Date.parse(entry.createdAt)),
		isSummary: true,
	});
	if (entry.firstKeptId !== null) {
		let keeping = false;
		for (const earlier of entries.slice(0, index)) {
			if (earlier.type !== "message") continue;
			if (earlier.id === entry.firstKeptId) keeping = true;
			if (keeping) visible.push({ id: earlier.id, message: earlier.message });
		}
	}
	for (const later of entries.slice(index + 1)) {
		if (later.type === "message") visible.push({ id: later.id, message: later.message });
	}
	return repairToolBlocks(visible);
}

function repairToolBlocks(messages: ProjectedMessage[]): ProjectedMessage[] {
	const repaired: ProjectedMessage[] = [];
	let index = 0;
	while (index < messages.length) {
		const current = messages[index];
		const calls = toolCalls(current.message);
		if (calls.length === 0) {
			repaired.push(current);
			index += 1;
			continue;
		}
		let cursor = index + 1;
		const results = new Map<string, ProjectedMessage>();
		while (cursor < messages.length && messages[cursor].message.role === "toolResult") {
			const result = messages[cursor];
			results.set((result.message as ToolResultMessage).toolCallId, result);
			cursor += 1;
		}
		const complete = calls.every((call) => results.has(call.id));
		if (complete || cursor < messages.length) {
			repaired.push(current);
			for (const call of calls) {
				repaired.push(results.get(call.id) ?? interrupted(current, call));
			}
		}
		index = cursor;
	}
	return repaired;
}

function interrupted(owner: ProjectedMessage, call: { id: string; name: string }): ProjectedMessage {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: toolResultText(interruptedResult(call.name)) }],
		isError: true,
		timestamp: owner.message.timestamp,
	};
	return { id: `${owner.id}:${call.id}:interrupted`, message };
}
