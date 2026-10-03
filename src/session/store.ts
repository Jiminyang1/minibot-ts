// Session persistence under <home>/sessions/<id>/:
//   meta.json      title, timestamps, workspace, message count (atomic rewrite)
//   entries.jsonl  the append-only log, the source of truth
//   artifacts/     large tool outputs (see tools/artifacts.ts)

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { latestCompaction, project, type ProjectedMessage } from "./projection.ts";
import {
	type ChatMessage,
	type CompactionEntry,
	DEFAULT_TITLE,
	isSessionEntry,
	isSessionMeta,
	messageText,
	type SessionEntry,
	type SessionMeta,
} from "./types.ts";
import { nowIso, preview, readJsonFile, shortId, timestampId, writeFileAtomic } from "../util.ts";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class SessionNotFoundError extends Error {
	override name = "SessionNotFoundError";
}

function validSessionId(id: string): boolean {
	return SESSION_ID.test(id);
}

export class Session {
	meta: SessionMeta;
	readonly entries: SessionEntry[];
	#projected: ProjectedMessage[] | undefined;

	constructor(meta: SessionMeta, entries: SessionEntry[]) {
		this.meta = meta;
		this.entries = entries;
	}

	get id(): string {
		return this.meta.id;
	}

	/** The conversation the model sees, with ids for compaction cut points. */
	projected(): ProjectedMessage[] {
		this.#projected ??= project(this.entries);
		return this.#projected;
	}

	messages(): ChatMessage[] {
		return this.projected().map((item) => item.message);
	}

	latestCompaction(): CompactionEntry | undefined {
		return latestCompaction(this.entries)?.entry;
	}

	/** Messages appended after the newest compaction (or all of them). */
	entriesSinceCompaction(): SessionEntry[] {
		const found = latestCompaction(this.entries);
		return found === undefined ? this.entries : this.entries.slice(found.index + 1);
	}

	turnCount(): number {
		return this.projected().filter((item) => item.message.role === "user" && !item.isSummary).length;
	}

	/** Called by the store after an entry is persisted. */
	push(entry: SessionEntry): void {
		this.entries.push(entry);
		this.#projected = undefined;
	}
}

export class SessionStore {
	readonly dir: string;
	readonly #currentPath: string;
	readonly #workspace: string;

	constructor(options: { dir: string; currentPath: string; workspace: string }) {
		this.dir = options.dir;
		this.#currentPath = options.currentPath;
		this.#workspace = options.workspace;
		mkdirSync(this.dir, { recursive: true });
	}

	sessionDir(id: string): string {
		if (!validSessionId(id)) throw new Error(`会话 id 无效: ${id}`);
		return join(this.dir, id);
	}

	create(title = DEFAULT_TITLE): Session {
		const base = timestampId("s");
		let id = base;
		for (let suffix = 1; existsSync(join(this.dir, id)); suffix++) id = `${base}_${suffix}`;
		const now = nowIso();
		const meta: SessionMeta = {
			id,
			title,
			createdAt: now,
			updatedAt: now,
			workspace: this.#workspace,
			messageCount: 0,
		};
		mkdirSync(this.sessionDir(id), { recursive: true });
		this.#writeMeta(meta);
		return new Session(meta, []);
	}

	load(id: string): Session | undefined {
		if (!validSessionId(id)) return undefined;
		const meta = readJsonFile(join(this.dir, id, "meta.json"));
		if (!isSessionMeta(meta)) return undefined;
		return new Session(meta, this.#readEntries(id));
	}

	list(): SessionMeta[] {
		const metas: SessionMeta[] = [];
		for (const name of readdirSync(this.dir)) {
			if (!validSessionId(name)) continue;
			const meta = readJsonFile(join(this.dir, name, "meta.json"));
			if (isSessionMeta(meta)) metas.push(meta);
		}
		return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	/** Persist one entry, then update the in-memory session and its metadata. */
	append(session: Session, entry: SessionEntry): void {
		appendFileSync(join(this.sessionDir(session.id), "entries.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
		session.push(entry);
		const meta = { ...session.meta, updatedAt: entry.createdAt, messageCount: session.projected().length };
		if (meta.title === DEFAULT_TITLE && entry.type === "message" && entry.message.role === "user") {
			const text = messageText(entry.message).trim();
			if (text) meta.title = preview(text, 30);
		}
		session.meta = meta;
		this.#writeMeta(meta);
	}

	appendMessage(session: Session, message: ChatMessage): void {
		this.append(session, { type: "message", id: shortId("m"), createdAt: nowIso(), message });
	}

	/** Start a new context: from here on the model sees only `handoff`; the log keeps everything. */
	reset(session: Session, handoff: string, tokensBefore: number): void {
		this.append(session, {
			type: "compaction",
			id: shortId("c"),
			createdAt: nowIso(),
			summary: handoff,
			firstKeptId: null,
			tokensBefore,
			details: { readFiles: [], modifiedFiles: [] },
		});
	}

	rename(session: Session, title: string): void {
		session.meta = { ...session.meta, title, updatedAt: nowIso() };
		this.#writeMeta(session.meta);
	}

	delete(id: string): boolean {
		if (!validSessionId(id) || !existsSync(join(this.dir, id))) return false;
		rmSync(join(this.dir, id), { recursive: true, force: true });
		if (this.currentId() === id) rmSync(this.#currentPath, { force: true });
		return true;
	}

	currentId(): string | undefined {
		try {
			const id = readFileSync(this.#currentPath, "utf8").trim();
			return validSessionId(id) ? id : undefined;
		} catch {
			return undefined;
		}
	}

	setCurrent(id: string): void {
		writeFileAtomic(this.#currentPath, `${id}\n`);
	}

	createCurrent(title?: string): Session {
		const session = this.create(title);
		this.setCurrent(session.id);
		return session;
	}

	/** Resume the current or latest non-empty session, or start a new one. */
	startup(): { session: Session; resumed: boolean } {
		const currentId = this.currentId();
		const current = currentId === undefined ? undefined : this.load(currentId);
		if (current) return { session: current, resumed: true };
		const latest = this.list().find((meta) => meta.messageCount > 0);
		const loaded = latest === undefined ? undefined : this.load(latest.id);
		if (loaded) {
			this.setCurrent(loaded.id);
			return { session: loaded, resumed: true };
		}
		return { session: this.createCurrent(), resumed: false };
	}

	/** Resolve a run target: empty → new current session, "current" → current. */
	resolve(target: string | undefined): Session {
		const id = target?.trim();
		if (!id) return this.createCurrent();
		if (id === "current") return this.startup().session;
		const session = this.load(id);
		if (!session) throw new SessionNotFoundError(`未找到会话: ${id}`);
		return session;
	}

	#readEntries(id: string): SessionEntry[] {
		let text: string;
		try {
			text = readFileSync(join(this.dir, id, "entries.jsonl"), "utf8");
		} catch {
			return [];
		}
		const entries: SessionEntry[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const value: unknown = JSON.parse(line);
				if (isSessionEntry(value)) entries.push(value);
			} catch {
				// A torn last line from a crash mid-append; everything before it is intact.
			}
		}
		return entries;
	}

	#writeMeta(meta: SessionMeta): void {
		writeFileAtomic(join(this.sessionDir(meta.id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
	}
}
