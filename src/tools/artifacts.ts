// Large tool outputs live as artifacts next to their session; the model reads
// them page by page with read_artifact.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { isRecord, nowIso, readJsonFile, sha256, shortId, writeFileAtomic } from "../util.ts";
import { type ArtifactKind, type ArtifactRef, failure, MAX_DATA_CHARS, type ToolOutput, type ToolResult } from "./result.ts";
import { defineTool, type Tool } from "./tool.ts";

const ARTIFACT_ID = /^a_[A-Za-z0-9_-]{3,128}$/;
const INLINE_CHARS = 12_000;
const PREVIEW_CHARS = 2_000;

interface StoredArtifact extends ArtifactRef {
	createdAt: string;
	content: string;
	sha256: string;
}

export interface ArtifactPage {
	ref: ArtifactRef;
	content: string;
	offset: number;
	totalChars: number;
	sha256: string;
}

export class ArtifactStore {
	readonly #sessionsDir: string;

	constructor(sessionsDir: string) {
		this.#sessionsDir = sessionsDir;
	}

	put(sessionId: string, content: string, kind: ArtifactKind, name: string | null): ArtifactRef {
		const ref: ArtifactRef = { id: shortId("a"), kind, name };
		const stored: StoredArtifact = { ...ref, createdAt: nowIso(), content, sha256: sha256(content) };
		writeFileAtomic(this.#path(sessionId, ref.id), JSON.stringify(stored));
		return ref;
	}

	read(sessionId: string, id: string, offset: number, limit: number): ArtifactPage | undefined {
		if (!ARTIFACT_ID.test(id)) return undefined;
		const value = readJsonFile(this.#path(sessionId, id));
		if (!isRecord(value) || typeof value.content !== "string") return undefined;
		const stored = value as unknown as StoredArtifact;
		const start = Math.min(offset, stored.content.length);
		return {
			ref: { id: stored.id, kind: stored.kind, name: stored.name },
			content: stored.content.slice(start, start + limit),
			offset: start,
			totalChars: stored.content.length,
			sha256: stored.sha256,
		};
	}

	/**
	 * Turn a tool's output into the envelope the model sees: short content is
	 * inlined, long content becomes an artifact plus a preview.
	 */
	materialize(output: ToolOutput, sessionId: string): ToolResult {
		const data = { ...output.data };
		// The summary comes right after the status: on failure it is what the model must read first.
		const envelope = (summary: string, artifact: ArtifactRef | null, truncated: boolean): ToolResult => ({
			ok: output.ok,
			code: output.code,
			summary,
			data,
			artifact,
			truncated,
		});
		if (output.content === undefined) return envelope(output.summary, null, output.truncated ?? false);
		if (output.content.length <= INLINE_CHARS) {
			data.content = output.content;
			return envelope(output.summary, null, output.truncated ?? false);
		}
		const artifact = this.put(sessionId, output.content, output.contentKind ?? "text", output.contentName ?? null);
		data.preview = output.content.slice(0, PREVIEW_CHARS);
		return envelope(`${output.summary.replace(/。$/, "")}(结果较大,已返回预览并保存为 artifact)。`, artifact, true);
	}

	#path(sessionId: string, id: string): string {
		const dir = join(this.#sessionsDir, sessionId, "artifacts");
		mkdirSync(dir, { recursive: true });
		return join(dir, `${id}.json`);
	}
}

const DEFAULT_LIMIT = 12_000;
const MAX_LIMIT = 24_000;

export function readArtifactTool(store: ArtifactStore): Tool {
	return defineTool({
		name: "read_artifact",
		description: "读取先前工具返回的大结果 artifact,按字符分页回查。",
		concurrent: true,
		parameters: Type.Object({
			artifact_id: Type.String({ description: "artifact id,例如 a_123abc。" }),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "起始字符偏移,默认 0。" })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "读取的字符数,默认 12000,上限 24000。" }),
			),
		}),
		execute(args, context): ToolOutput {
			const id = args.artifact_id.trim();
			const page = store.read(context.sessionId, id, args.offset ?? 0, args.limit ?? DEFAULT_LIMIT);
			if (!page) return failure("not_found", `未找到 artifact ${id}。`, { data: { artifact_id: id } });
			const fields = (content: string) => {
				const end = page.offset + content.length;
				const nextOffset = end < page.totalChars ? end : null;
				return {
					artifact_id: id,
					kind: page.ref.kind,
					name: page.ref.name,
					content,
					offset: page.offset,
					returned_chars: content.length,
					next_offset: nextOffset,
					has_more: nextOffset !== null,
					total_chars: page.totalChars,
					file_sha256: page.sha256,
				};
			};
			const content = fitToDataLimit(page.content, (text) => JSON.stringify(fields(text)).length);
			const data = fields(content);
			return {
				ok: true,
				code: "success",
				summary: `已读取 artifact ${id}(${page.offset}-${page.offset + content.length}/${page.totalChars} 字符)。`,
				data,
				truncated: data.has_more,
			};
		},
	});
}

/** The longest prefix of `text` whose serialized size stays under MAX_DATA_CHARS. */
function fitToDataLimit(text: string, size: (text: string) => number): string {
	if (size(text) <= MAX_DATA_CHARS) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (size(text.slice(0, mid)) <= MAX_DATA_CHARS) low = mid;
		else high = mid - 1;
	}
	return text.slice(0, low);
}
