// HTTP + SSE API for the web UI.
//
//   GET    /sessions                      list, with the current session id
//   POST   /sessions                      create and make current
//   GET    /sessions/:id                  one session ("current" allowed)
//   PATCH  /sessions/:id                  rename { title }
//   DELETE /sessions/:id
//   GET    /sessions/:id/messages         the conversation as shown
//   POST   /runs                          start a turn { input, sessionId? } → 202
//   GET    /runs/:id/events               SSE; Last-Event-ID resumes after a seq
//   POST   /runs/:id/cancel
//   POST   /runs/:id/approvals/:approvalId { approved }

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ApprovalBroker } from "../runtime/approval.ts";
import type { Runtime } from "../runtime/bootstrap.ts";
import { makeRunId } from "../runtime/agent-session.ts";
import type { RuntimeEvent } from "../runtime/events.ts";
import type { Session } from "../session/store.ts";
import { messageText } from "../session/types.ts";
import { errorMessage, isRecord } from "../util.ts";

export interface SessionView {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

export interface MessageView {
	role: "user" | "assistant";
	text: string;
	createdAt: string;
}

export interface StaticAsset {
	type: string;
	body: string | Buffer;
}

const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));

/** index.html, styles.css, and app.ts bundled for the browser. */
export async function webAssets(): Promise<Map<string, StaticAsset>> {
	const bundle = await build({
		entryPoints: [`${WEB_DIR}app.ts`],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		write: false,
		minify: true,
	});
	return new Map<string, StaticAsset>([
		["index.html", { type: "text/html; charset=utf-8", body: readFileSync(`${WEB_DIR}index.html`) }],
		["styles.css", { type: "text/css; charset=utf-8", body: readFileSync(`${WEB_DIR}styles.css`) }],
		["app.js", { type: "text/javascript; charset=utf-8", body: Buffer.from(bundle.outputFiles[0].contents) }],
	]);
}

/** Events kept for replay; deltas go only to live subscribers. */
class RunEvents {
	readonly #events = new Map<string, RuntimeEvent[]>();
	readonly #listeners = new Map<string, Set<(event: RuntimeEvent | undefined) => void>>();
	readonly #finished = new Set<string>();

	create(runId: string): void {
		this.#events.set(runId, []);
		if (this.#events.size > 200) {
			for (const id of this.#events.keys()) {
				if (!this.#finished.has(id)) continue;
				this.#events.delete(id);
				this.#finished.delete(id);
				break;
			}
		}
	}

	has(runId: string): boolean {
		return this.#events.has(runId);
	}

	push(event: RuntimeEvent): void {
		const stored = this.#events.get(event.runId);
		if (!stored) return;
		const wire = forWire(event);
		if (event.type !== "model.delta") stored.push(wire);
		const terminal = event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";
		for (const listener of this.#listeners.get(event.runId) ?? []) {
			listener(wire);
			if (terminal) listener(undefined);
		}
		if (terminal) {
			this.#finished.add(event.runId);
			this.#listeners.delete(event.runId);
		}
	}

	/** Replay after `lastSeq`, then follow; `undefined` marks the end. */
	subscribe(runId: string, lastSeq: number, listener: (event: RuntimeEvent | undefined) => void): () => void {
		for (const event of this.#events.get(runId) ?? []) if (event.seq > lastSeq) listener(event);
		if (this.#finished.has(runId)) {
			listener(undefined);
			return () => {};
		}
		const set = this.#listeners.get(runId) ?? new Set();
		set.add(listener);
		this.#listeners.set(runId, set);
		return () => set.delete(listener);
	}
}

/** The browser never needs full requests; they would bloat every frame. */
function forWire(event: RuntimeEvent): RuntimeEvent {
	if (event.type === "model.started" || event.type === "compaction.started") {
		return { ...event, payload: { ...event.payload, messages: [] } } as RuntimeEvent;
	}
	return event;
}

function sessionView(session: Session): SessionView {
	const { id, title, createdAt, updatedAt, messageCount } = session.meta;
	return { id, title, createdAt, updatedAt, messageCount };
}

function messageViews(session: Session): MessageView[] {
	return session.messages().flatMap((message) => {
		if (message.role !== "user" && message.role !== "assistant") return [];
		const text = messageText(message).trim();
		return text ? [{ role: message.role, text, createdAt: new Date(message.timestamp).toISOString() }] : [];
	});
}

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	let raw = "";
	for await (const chunk of request) raw += chunk;
	if (!raw) return {};
	const value: unknown = JSON.parse(raw);
	if (!isRecord(value)) throw new HttpError(400, "请求体必须是 JSON 对象");
	return value;
}

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

export function createApp(runtime: Runtime, broker: ApprovalBroker, assets: Map<string, StaticAsset>): Server {
	const runs = new RunEvents();
	const { store, session: agent } = runtime;

	const loadSession = (id: string): Session => {
		const session = id === "current" ? store.startup().session : store.load(id);
		if (!session) throw new HttpError(404, "会话不存在");
		return session;
	};

	const startRun = (input: string, target: string | undefined): { runId: string; sessionId: string } => {
		const session = target === undefined ? store.startup().session : loadSession(target);
		if (agent.isBusy(session.id)) throw new HttpError(409, `会话 ${session.id} 已有运行中的 turn`);
		const runId = makeRunId();
		runs.create(runId);
		agent.prompt(session.id, input, { source: "server", runId, onEvent: (event) => runs.push(event) }).catch(() => {
			// The failure already went out as run.failed or run.cancelled.
		});
		return { runId, sessionId: session.id };
	};

	const streamEvents = (request: IncomingMessage, response: ServerResponse, runId: string) => {
		if (!runs.has(runId)) throw new HttpError(404, "run 不存在");
		const lastSeq = Number((request.headers["last-event-id"] as string | undefined)?.split(":").at(-1) ?? 0) || 0;
		response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
		const keepalive = setInterval(() => response.write(": keepalive\n\n"), 10_000);
		const stop = runs.subscribe(runId, lastSeq, (event) => {
			if (event === undefined) {
				clearInterval(keepalive);
				response.end();
				return;
			}
			response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
		});
		request.on("close", () => {
			clearInterval(keepalive);
			stop();
		});
	};

	const route = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const method = request.method ?? "GET";

		if (method === "GET" && (parts.length === 0 || parts[0] === "static")) {
			const asset = assets.get(parts.length === 0 ? "index.html" : parts.slice(1).join("/"));
			if (!asset) throw new HttpError(404, "not found");
			response.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
			response.end(asset.body);
			return;
		}
		if (parts[0] === "sessions") {
			if (parts.length === 1 && method === "GET") {
				send(response, 200, { currentId: store.currentId() ?? null, sessions: store.list().map((meta) => ({ ...meta })) });
				return;
			}
			if (parts.length === 1 && method === "POST") {
				const body = await readJson(request);
				const created = store.createCurrent(typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined);
				send(response, 201, { session: sessionView(created) });
				return;
			}
			const id = parts[1];
			if (parts.length === 2 && method === "GET") {
				send(response, 200, { session: sessionView(loadSession(id)) });
				return;
			}
			if (parts.length === 2 && method === "PATCH") {
				const body = await readJson(request);
				const title = typeof body.title === "string" ? body.title.trim() : "";
				if (!title || title.length > 200) throw new HttpError(400, "title 必须是 1 到 200 个字符");
				const session = loadSession(id);
				store.rename(session, title);
				send(response, 200, { session: sessionView(session) });
				return;
			}
			if (parts.length === 2 && method === "DELETE") {
				if (id === "current") throw new HttpError(400, "不能删除 current 别名");
				if (agent.isBusy(id)) throw new HttpError(409, "会话正在运行");
				if (!store.delete(id)) throw new HttpError(404, "会话不存在");
				send(response, 200, { ok: true, sessionId: id });
				return;
			}
			if (parts.length === 3 && parts[2] === "messages" && method === "GET") {
				const session = loadSession(id);
				send(response, 200, { session: sessionView(session), messages: messageViews(session) });
				return;
			}
		}
		if (parts[0] === "runs") {
			if (parts.length === 1 && method === "POST") {
				const body = await readJson(request);
				const input = typeof body.input === "string" ? body.input.trim() : "";
				if (!input) throw new HttpError(400, "input 不能为空");
				const target = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
				send(response, 202, { ...startRun(input, target), status: "running" });
				return;
			}
			const runId = parts[1];
			if (parts.length === 3 && parts[2] === "events" && method === "GET") {
				streamEvents(request, response, runId);
				return;
			}
			if (parts.length === 3 && parts[2] === "cancel" && method === "POST") {
				if (!agent.abort(runId)) throw new HttpError(404, "run 不存在或已结束");
				send(response, 200, { ok: true, runId });
				return;
			}
			if (parts.length === 4 && parts[2] === "approvals" && method === "POST") {
				const body = await readJson(request);
				if (typeof body.approved !== "boolean") throw new HttpError(400, "approved 必须是布尔值");
				send(response, 200, { ok: true, matched: broker.resolve(runId, parts[3], body.approved) });
				return;
			}
		}
		throw new HttpError(404, "not found");
	};

	return createServer((request, response) => {
		route(request, response).catch((error: unknown) => {
			const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
			if (!response.headersSent) send(response, status, { error: errorMessage(error) });
			else response.end();
		});
	});
}
