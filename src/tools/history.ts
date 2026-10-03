// Keyword search over every stored conversation, including compaction
// summaries. At one user's scale, scanning the source of truth beats an
// embedding pipeline on freshness and transparency.

import { Type } from "typebox";
import type { SessionStore } from "../session/store.ts";
import { messageText } from "../session/types.ts";
import { failure, success, type ToolOutput } from "./result.ts";
import { defineTool, type Tool } from "./tool.ts";

const MAX_SESSIONS = 200;

interface Match {
	session_id: string;
	title: string;
	workspace: string;
	kind: string;
	created_at: string;
	snippet: string;
}

function snippet(text: string, term: string): string {
	const compact = text.split(/\s+/).filter(Boolean).join(" ");
	const position = Math.max(0, compact.toLowerCase().indexOf(term));
	const start = Math.max(0, position - 80);
	const end = Math.min(compact.length, position + 160);
	return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

export function searchHistoryTool(store: SessionStore): Tool {
	return defineTool({
		name: "search_history",
		description:
			"跨会话搜索历史对话(含被压缩会话的摘要)。当用户提到“上次 / 之前 / 那次聊过 / 我说过 / 我们讨论过”等指向过去对话的内容时使用。" +
			"多个关键词用空格分隔,全部命中才算匹配;结果带 session_id 便于追溯。找不到时先减少或更换关键词再试。",
		concurrent: true,
		parameters: Type.Object({
			query: Type.String({ description: "搜索关键词,空格分隔多个词(AND 关系),大小写不敏感" }),
			days: Type.Optional(Type.Integer({ minimum: 1, description: "只搜最近 N 天的会话" })),
			session_id: Type.Optional(Type.String({ description: "只搜指定会话" })),
			workspace: Type.Optional(Type.String({ description: "按会话创建时的工作目录过滤(子串匹配)" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "最多返回多少条匹配(默认 8)" })),
		}),
		execute(args, context): ToolOutput {
			const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
			if (terms.length === 0) return failure("invalid_args", "query 不能为空。");
			const cutoff = args.days === undefined ? undefined : new Date(Date.now() - args.days * 86_400_000).toISOString();
			const matches: Match[] = [];
			let searched = 0;
			for (const meta of store.list()) {
				if (searched >= MAX_SESSIONS) break;
				// The ongoing conversation is "now", not history.
				if (meta.id === context.sessionId) continue;
				if (args.session_id !== undefined && meta.id !== args.session_id) continue;
				if (args.workspace !== undefined && !meta.workspace.includes(args.workspace)) continue;
				if (cutoff !== undefined && meta.updatedAt < cutoff) continue;
				const session = store.load(meta.id);
				if (!session) continue;
				searched += 1;
				for (const entry of session.entries) {
					if (cutoff !== undefined && entry.createdAt < cutoff) continue;
					const text = entry.type === "compaction" ? entry.summary : messageText(entry.message);
					const lowered = text.toLowerCase();
					if (!terms.every((term) => lowered.includes(term))) continue;
					matches.push({
						session_id: meta.id,
						title: meta.title,
						workspace: meta.workspace,
						kind: entry.type === "compaction" ? "summary" : entry.message.role,
						created_at: entry.createdAt,
						snippet: snippet(text, terms[0]),
					});
				}
			}
			matches.sort((a, b) => b.created_at.localeCompare(a.created_at));
			const shown = matches.slice(0, args.limit ?? 8);
			if (shown.length === 0) {
				return success(`在 ${searched} 个历史会话中未找到匹配,可减少或更换关键词。`, {
					data: { matches: [], searched_sessions: searched, query: args.query },
				});
			}
			return success(`在 ${searched} 个历史会话中找到 ${matches.length} 条匹配(展示最新 ${shown.length} 条)。`, {
				data: { matches: shown, total_matches: matches.length, searched_sessions: searched },
			});
		},
	});
}
