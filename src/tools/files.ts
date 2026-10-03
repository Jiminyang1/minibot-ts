// File tools rooted at the workspace: read, write, hash-guarded line edits,
// directory listing, and content search.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { sha256 } from "../util.ts";
import { failure, noop, success, type ToolOutput } from "./result.ts";
import { defineTool, type Tool } from "./tool.ts";

const MAX_FILE_BYTES = 256 * 1024;

class OutsideWorkspace extends Error {}

/** Resolve `path` under the workspace and refuse anything that escapes it. */
export function resolveInWorkspace(workspace: string, path: string): string {
	const resolved = resolve(workspace, path);
	const rel = relative(workspace, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new OutsideWorkspace(`路径 ${path} 超出工作目录 ${workspace}`);
	}
	return resolved;
}

function guarded(path: string, workspace: string, run: (resolved: string) => ToolOutput): ToolOutput {
	let resolved: string;
	try {
		resolved = resolveInWorkspace(workspace, path);
	} catch (error) {
		return failure("permission_denied", `[安全拦截] ${(error as Error).message}`, { data: { path } });
	}
	return run(resolved);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** File text, or undefined when the bytes are not valid UTF-8. */
function readUtf8(path: string): string | undefined {
	try {
		return strictUtf8.decode(readFileSync(path));
	} catch {
		return undefined;
	}
}

export const readFileTool: Tool = defineTool({
	name: "read_file",
	description: "读取文件内容",
	concurrent: true,
	parameters: Type.Object({ path: Type.String({ description: "文件路径" }) }),
	execute: (args, context) =>
		guarded(args.path, context.workspace, (file) => {
			if (!existsSync(file) || !statSync(file).isFile()) {
				return failure("not_found", `文件不存在: ${args.path}`, { data: { path: args.path } });
			}
			const size = statSync(file).size;
			if (size > MAX_FILE_BYTES) {
				return failure("error", `文件过大 (${size} bytes),上限 ${MAX_FILE_BYTES} bytes。`, {
					data: { path: args.path, size_bytes: size },
				});
			}
			const text = readUtf8(file);
			if (text === undefined) return failure("error", `文件无法以 UTF-8 解码: ${args.path}`, { data: { path: args.path } });
			return success(`已读取 ${args.path}(${text.length} 字符)。`, {
				data: { path: args.path, total_chars: text.length, file_sha256: sha256(text) },
				content: text,
				contentKind: "file",
				contentName: args.path,
			});
		}),
});

export const writeFileTool: Tool = defineTool({
	name: "write_file",
	description: "写入文件内容。如果文件已存在则覆盖(需带 expected_sha256),不存在则创建(含中间目录)。",
	requiresApproval: true,
	parameters: Type.Object({
		path: Type.String({ description: "文件路径" }),
		content: Type.String({ description: "要写入的文件内容" }),
		expected_sha256: Type.Optional(
			Type.String({
				description:
					"覆盖已有文件时必填,应来自最近一次 read_file 或 read_artifact 返回的 data.file_sha256;不匹配会返回 conflict。新建文件可不传。",
			}),
		),
	}),
	execute: (args, context) =>
		guarded(args.path, context.workspace, (file) => {
			const bytes = Buffer.byteLength(args.content, "utf8");
			if (bytes > MAX_FILE_BYTES) {
				return failure("error", `内容过大 (${bytes} bytes),上限 ${MAX_FILE_BYTES} bytes。`, {
					data: { path: args.path, size_bytes: bytes },
				});
			}
			const existed = existsSync(file);
			if (existed) {
				const current = readUtf8(file);
				if (current === undefined) {
					return failure("conflict", "无法校验现有文件(非 UTF-8),拒绝覆盖。", { data: { path: args.path } });
				}
				const currentSha = sha256(current);
				if (args.expected_sha256 === undefined) {
					return failure("conflict", "覆盖已有文件需提供 expected_sha256(请先 read_file 获取)。", {
						data: { path: args.path, current_sha256: currentSha },
					});
				}
				if (args.expected_sha256 !== currentSha) {
					return failure("conflict", "文件已被修改,sha256 不匹配。请重新 read_file 再写。", {
						data: { path: args.path, expected_sha256: args.expected_sha256, current_sha256: currentSha },
					});
				}
			}
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, args.content, "utf8");
			return success(`已写入 ${args.path}(${args.content.length} 字符)。`, {
				data: { path: args.path, chars_written: args.content.length, created: !existed, file_sha256: sha256(args.content) },
			});
		}),
});

const EditOp = Type.Object(
	{
		op: Type.Union([
			Type.Literal("replace"),
			Type.Literal("insert_before"),
			Type.Literal("insert_after"),
			Type.Literal("append"),
		]),
		start_line: Type.Optional(Type.Integer({ minimum: 1 })),
		end_line: Type.Optional(Type.Integer({ minimum: 1 })),
		line: Type.Optional(Type.Integer({ minimum: 1 })),
		old_text: Type.Optional(Type.String()),
		new_text: Type.String(),
	},
	{ additionalProperties: false },
);

interface Mutation {
	start: number;
	end: number;
	text: string;
	label: string;
}

export const editFileTool: Tool = defineTool({
	name: "edit_file",
	description:
		"在已有 UTF-8 文件上执行基于 expected_sha256 的行级编辑。调用前必须先 read_file 或 read_artifact 取得 data.file_sha256。" +
		"支持 replace、insert_before、insert_after、append;拒绝过期快照、错误行范围和重叠编辑。",
	requiresApproval: true,
	parameters: Type.Object({
		path: Type.String({ description: "要编辑的文件路径。" }),
		expected_sha256: Type.String({
			description: "必须来自最近一次 read_file 或 read_artifact 的 data.file_sha256。若文件已变更,将返回 conflict。",
		}),
		edits: Type.Array(EditOp, {
			minItems: 1,
			description:
				"编辑列表。replace 需要 start_line/end_line/old_text/new_text;insert_before 与 insert_after 需要 line/new_text;append 只需要 new_text。所有行号均为 1-based。",
		}),
	}),
	execute: (args, context) =>
		guarded(args.path, context.workspace, (file) => {
			if (!existsSync(file) || !statSync(file).isFile()) {
				return failure("not_found", `文件不存在: ${args.path}`, { data: { path: args.path } });
			}
			const size = statSync(file).size;
			if (size > MAX_FILE_BYTES) {
				return failure("error", `文件过大 (${size} bytes),上限 ${MAX_FILE_BYTES} bytes。`, {
					data: { path: args.path, size_bytes: size },
				});
			}
			const original = readUtf8(file);
			if (original === undefined) return failure("error", `文件无法以 UTF-8 解码: ${args.path}`, { data: { path: args.path } });
			const currentSha = sha256(original);
			if (args.expected_sha256 !== currentSha) {
				return failure("conflict", "文件已被修改,sha256 不匹配。请重新 read_file 再 edit。", {
					data: { path: args.path, expected_sha256: args.expected_sha256, current_sha256: currentSha },
				});
			}

			const spans = lineSpans(original);
			const mutations: Mutation[] = [];
			for (const [index, edit] of args.edits.entries()) {
				const built = buildMutation(original, spans, edit, index + 1);
				if (typeof built === "string") {
					return failure("invalid_args", built, { data: { path: args.path, edit_index: index + 1 } });
				}
				mutations.push(built);
			}
			const overlap = findOverlap(mutations);
			if (overlap) {
				return failure("invalid_args", "edits 存在重叠或共享同一插入点,请先合并为单个 edit。", {
					data: { path: args.path, previous_edit: overlap[0], conflicting_edit: overlap[1] },
				});
			}

			let updated = original;
			for (const m of [...mutations].sort((a, b) => b.start - a.start || b.end - a.end)) {
				updated = updated.slice(0, m.start) + m.text + updated.slice(m.end);
			}
			if (updated === original) return noop("编辑结果与原文件相同,无需写入。", { path: args.path });
			const temp = `${file}.${process.pid}.tmp`;
			writeFileSync(temp, updated, "utf8");
			renameSync(temp, file);
			return success(`已编辑 ${args.path}(应用 ${mutations.length} 处变更)。`, {
				data: {
					path: args.path,
					edits_applied: mutations.length,
					previous_sha256: currentSha,
					file_sha256: sha256(updated),
				},
			});
		}),
});

/** [start, end) offsets of each line, line endings included. */
function lineSpans(text: string): [number, number][] {
	const spans: [number, number][] = [];
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		if (text[index] === "\n") {
			spans.push([start, index + 1]);
			start = index + 1;
		}
	}
	if (start < text.length) spans.push([start, text.length]);
	return spans;
}

type Edit = {
	op: "replace" | "insert_before" | "insert_after" | "append";
	start_line?: number;
	end_line?: number;
	line?: number;
	old_text?: string;
	new_text: string;
};

function buildMutation(original: string, spans: [number, number][], edit: Edit, n: number): Mutation | string {
	const label = `${edit.op}#${n}`;
	switch (edit.op) {
		case "replace": {
			const { start_line: from, end_line: to, old_text: oldText } = edit;
			if (from === undefined || to === undefined) return `第 ${n} 个 replace edit 必须提供 start_line 和 end_line。`;
			if (oldText === undefined) return `第 ${n} 个 replace edit 必须提供 old_text。`;
			if (from > to) return `第 ${n} 个 replace edit 的 start_line 不能大于 end_line。`;
			if (spans.length === 0) return `第 ${n} 个 replace edit 无法作用于空文件。`;
			if (to > spans.length) return `第 ${n} 个 replace edit 超出文件行数 ${spans.length}。`;
			const start = spans[from - 1][0];
			const end = spans[to - 1][1];
			const actual = original.slice(start, end);
			if (actual !== oldText) {
				const shown = actual.length > 200 ? `${actual.slice(0, 200)}...` : actual;
				return `第 ${n} 个 replace edit 的 old_text 与 ${from}-${to} 行内容不一致。实际内容: ${JSON.stringify(shown)}`;
			}
			return { start, end, text: edit.new_text, label };
		}
		case "insert_before": {
			const line = edit.line;
			if (line === undefined) return `第 ${n} 个 insert_before edit 必须提供 line。`;
			if (spans.length === 0) {
				if (line !== 1) return `空文件只能对第 1 行做 insert_before;收到 line=${line}。`;
				return { start: 0, end: 0, text: edit.new_text, label };
			}
			if (line > spans.length + 1) return `第 ${n} 个 insert_before edit 超出允许行号 ${spans.length + 1}。`;
			const start = line === spans.length + 1 ? original.length : spans[line - 1][0];
			return { start, end: start, text: edit.new_text, label };
		}
		case "insert_after": {
			const line = edit.line;
			if (line === undefined) return `第 ${n} 个 insert_after edit 必须提供 line。`;
			if (spans.length === 0) return `空文件不能执行第 ${n} 个 insert_after edit,请改用 append 或 insert_before(line=1)。`;
			if (line > spans.length) return `第 ${n} 个 insert_after edit 超出文件行数 ${spans.length}。`;
			const start = spans[line - 1][1];
			return { start, end: start, text: edit.new_text, label };
		}
		case "append":
			return { start: original.length, end: original.length, text: edit.new_text, label };
	}
}

/** Two edits overlap, or both insert at the same point. */
function findOverlap(mutations: Mutation[]): [string, string] | undefined {
	const sorted = [...mutations].sort((a, b) => a.start - b.start || a.end - b.end);
	for (let index = 1; index < sorted.length; index++) {
		const previous = sorted[index - 1];
		const current = sorted[index];
		const touching = current.start === previous.end && (current.start === current.end || previous.start === previous.end);
		if (current.start < previous.end || touching) return [previous.label, current.label];
	}
	return undefined;
}

const MAX_ENTRIES = 200;

export const listDirTool: Tool = defineTool({
	name: "list_dir",
	description: "列出目录内容。返回文件名列表,目录名以 / 结尾。",
	concurrent: true,
	parameters: Type.Object({ path: Type.Optional(Type.String({ description: "目录路径,默认为当前目录" })) }),
	execute: (args, context) => {
		const path = args.path ?? ".";
		return guarded(path, context.workspace, (dir) => {
			if (!existsSync(dir)) return failure("not_found", `路径不存在: ${path}`, { data: { path } });
			if (!statSync(dir).isDirectory()) return failure("error", `不是目录: ${path}`, { data: { path } });
			const entries = readdirSync(dir, { withFileTypes: true }).sort(
				(a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
			);
			const names = entries.slice(0, MAX_ENTRIES).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
			const truncated = entries.length > MAX_ENTRIES;
			return success(
				truncated ? `已列出 ${path} 的前 ${names.length} 项(共 ${entries.length} 项)。` : `已列出 ${path},共 ${entries.length} 项。`,
				{ data: { path, entries: names, total_entries: entries.length }, truncated },
			);
		});
	},
});

const MAX_MATCHES = 50;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", ".minibot"]);

/** `*` and `?` match within one path segment, `**` across segments. */
export function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				pattern += ".*";
				index += 1;
			} else pattern += "[^/]*";
		} else if (char === "?") pattern += "[^/]";
		else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${pattern}$`);
}

function* walk(root: string): Generator<string> {
	for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const full = join(root, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.isFile()) yield full;
	}
}

export const searchFilesTool: Tool = defineTool({
	name: "search_files",
	description: "在目录中搜索文件内容。支持正则表达式,返回匹配的文件名、行号和内容。",
	concurrent: true,
	parameters: Type.Object({
		pattern: Type.String({ description: "搜索的正则表达式" }),
		path: Type.Optional(Type.String({ description: "搜索的目录路径,默认为当前目录" })),
		glob: Type.Optional(Type.String({ description: "文件名过滤,例如 '*.ts',默认 '*'" })),
	}),
	execute: (args, context) => {
		const path = args.path ?? ".";
		const glob = args.glob ?? "*";
		return guarded(path, context.workspace, (root) => {
			if (!existsSync(root) || !statSync(root).isDirectory()) return failure("not_found", `不是目录: ${path}`, { data: { path } });
			let regex: RegExp;
			try {
				regex = new RegExp(args.pattern);
			} catch (error) {
				return failure("invalid_args", `正则表达式无效: ${(error as Error).message}`, { data: { pattern: args.pattern } });
			}
			const fileFilter = globToRegExp(glob);
			const matches: string[] = [];
			for (const file of walk(root)) {
				const rel = relative(root, file).split(sep).join("/");
				const target = glob.includes("/") ? rel : rel.slice(rel.lastIndexOf("/") + 1);
				if (!fileFilter.test(target) || statSync(file).size > MAX_FILE_BYTES) continue;
				const lines = readFileSync(file, "utf8").split("\n");
				lines.forEach((line, index) => {
					if (regex.test(line)) matches.push(`${rel}:${index + 1}: ${line.trimEnd()}`);
				});
			}
			if (matches.length === 0) {
				return failure("not_found", `未找到匹配: ${args.pattern}`, {
					data: { pattern: args.pattern, path, total_matches: 0, matches: [] },
				});
			}
			const truncated = matches.length > MAX_MATCHES;
			return success(`找到 ${matches.length} 处匹配。`, {
				data: { pattern: args.pattern, path, glob, total_matches: matches.length, matches: matches.slice(0, MAX_MATCHES) },
				content: truncated ? matches.join("\n") : undefined,
				contentName: `search:${args.pattern}`,
				truncated,
			});
		});
	},
});

export const fileTools: readonly Tool[] = [readFileTool, writeFileTool, editFileTool, listDirTool, searchFilesTool];
