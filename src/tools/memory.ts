// Long-term memory: short, stable facts about the user, shared by every
// session. The model writes it with remember/forget; every request carries
// the current facts in the system prompt.

import { Type } from "typebox";
import { isRecord, readJsonFile, withFileLock, writeFileAtomic } from "../util.ts";
import { failure, success, type ToolOutput } from "./result.ts";
import { defineTool, type Tool } from "./tool.ts";

export interface MemoryItem {
	/** `mem_N`; never reused, so a stale id can't point at a newer fact. */
	id: string;
	content: string;
	createdAt: string;
}

interface MemoryFile {
	items: MemoryItem[];
	nextIndex: number;
}

export class MemoryStore {
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	list(): MemoryItem[] {
		return this.#read().items;
	}

	add(content: string): MemoryItem {
		const text = content.trim();
		if (!text) throw new Error("记忆内容不能为空。");
		return this.#update((file) => {
			const item: MemoryItem = { id: `mem_${file.nextIndex}`, content: text, createdAt: localTimestamp() };
			return [{ items: [...file.items, item], nextIndex: file.nextIndex + 1 }, item];
		});
	}

	delete(id: string): boolean {
		return this.#update((file) => {
			const items = file.items.filter((item) => item.id !== id);
			return [{ ...file, items }, items.length !== file.items.length];
		});
	}

	clear(): number {
		return this.#update((file) => [{ ...file, items: [] }, file.items.length]);
	}

	#update<T>(change: (file: MemoryFile) => [MemoryFile, T]): T {
		return withFileLock(`${this.#path}.lock`, () => {
			const [next, result] = change(this.#read());
			writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`);
			return result;
		});
	}

	#read(): MemoryFile {
		const value = readJsonFile(this.#path);
		if (!isRecord(value) || !Array.isArray(value.items)) return { items: [], nextIndex: 1 };
		const items = value.items.filter(
			(item): item is MemoryItem =>
				isRecord(item) && typeof item.id === "string" && typeof item.content === "string" && typeof item.createdAt === "string",
		);
		const highest = Math.max(0, ...items.map((item) => Number(/^mem_(\d+)$/.exec(item.id)?.[1] ?? 0)));
		const stored = typeof value.nextIndex === "number" ? value.nextIndex : 1;
		return { items, nextIndex: Math.max(stored, highest + 1) };
	}
}

function localTimestamp(): string {
	const now = new Date();
	const offset = -now.getTimezoneOffset();
	const local = new Date(now.getTime() + offset * 60_000).toISOString().slice(0, 19);
	const sign = offset >= 0 ? "+" : "-";
	const abs = Math.abs(offset);
	return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function memoryTools(store: MemoryStore): Tool[] {
	return [
		defineTool({
			name: "remember",
			description:
				"把一条关于用户的稳定事实写入长期记忆,跨会话可见。适合:姓名、身份、常用环境、偏好、固定习惯。" +
				"不适合:一次性的临时信息、每日进度、项目状态。如果是对同一事实的更新,请先用 forget 删除旧条目,再写入新的。",
			parameters: Type.Object({ content: Type.String({ description: "要记住的事实,一句话,尽量自足可读。" }) }),
			execute(args): ToolOutput {
				try {
					const item = store.add(args.content);
					return success(`已记住 [${item.id}]。`, { data: { memory_id: item.id, content: item.content } });
				} catch (error) {
					return failure("invalid_args", `写入失败: ${(error as Error).message}`);
				}
			},
		}),
		defineTool({
			name: "forget",
			description: "按 id 删除一条长期记忆。用于修正过时或错误的事实;id 在系统提示的用户记忆数据块中。",
			parameters: Type.Object({ memory_id: Type.String({ description: "要删除的记忆 id,例如 mem_1。" }) }),
			execute(args): ToolOutput {
				const id = args.memory_id.trim();
				if (!store.delete(id)) return failure("not_found", `未找到记忆 ${id}。`, { data: { memory_id: id } });
				return success(`已删除记忆 ${id}。`, { data: { memory_id: id } });
			},
		}),
	];
}
