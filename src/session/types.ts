// Session log records. A session is an append-only list of entries; the
// model-visible conversation is a projection of it (see projection.ts).

import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { isRecord } from "../util.ts";

/** The messages MiniBot stores: pi-ai's user, assistant, and tool-result messages. */
export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface MessageEntry {
	type: "message";
	id: string;
	createdAt: string;
	message: ChatMessage;
}

/** Files the compacted part of the conversation read or modified. */
export interface FileDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CompactionEntry {
	type: "compaction";
	id: string;
	createdAt: string;
	summary: string;
	/** First message entry kept verbatim; null keeps nothing before this entry. */
	firstKeptId: string | null;
	tokensBefore: number;
	details: FileDetails;
}

export type SessionEntry = MessageEntry | CompactionEntry;

export interface SessionMeta {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Directory the session started in. Provenance only; state is global. */
	workspace: string;
	messageCount: number;
}

export const DEFAULT_TITLE = "新会话";

export function isSessionMeta(value: unknown): value is SessionMeta {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		typeof value.workspace === "string" &&
		typeof value.messageCount === "number"
	);
}

export function isSessionEntry(value: unknown): value is SessionEntry {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.createdAt !== "string") return false;
	if (value.type === "message") {
		return isRecord(value.message) && ["user", "assistant", "toolResult"].includes(value.message.role as string);
	}
	if (value.type === "compaction") {
		return typeof value.summary === "string" && isRecord(value.details);
	}
	return false;
}

/** Plain text of a message's text blocks. */
export function messageText(message: ChatMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

export function thinkingText(message: AssistantMessage): string {
	return message.content.map((block) => (block.type === "thinking" ? block.thinking : "")).join("");
}

export function toolCalls(message: ChatMessage): { id: string; name: string; arguments: Record<string, unknown> }[] {
	if (message.role !== "assistant") return [];
	return message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
}

/** Usage of a message no model produced. */
export function emptyUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
