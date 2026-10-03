// Shared helpers for the step-0 checks: a result reporter, a local
// OpenAI-compatible mock server, and a provider that points at it.

import http from "node:http";
import { readFileSync } from "node:fs";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export type Verdict = "PASS" | "FAIL" | "INFO";

const results: { check: string; verdict: Verdict; detail: string }[] = [];

export function report(check: string, verdict: Verdict, detail: string): void {
	results.push({ check, verdict, detail });
	console.log(`[${verdict}] ${check}\n       ${detail.replaceAll("\n", "\n       ")}`);
}

export function summary(): { check: string; verdict: Verdict; detail: string }[] {
	return results;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read only the keys we need from MiniBot's .env; never print values. */
export function loadMinibotEnv(path: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
		if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	return env;
}

// ── mock OpenAI-compatible server ──────────────────────────────────

export interface MockCall {
	n: number;
	body: any;
	res: http.ServerResponse;
}

export interface MockServer {
	url: string;
	bodies: any[];
	count(): number;
	close(): Promise<void>;
}

export async function startMock(handler: (call: MockCall) => void | Promise<void>): Promise<MockServer> {
	let n = 0;
	const bodies: any[] = [];
	const server = http.createServer(async (req, res) => {
		let raw = "";
		for await (const part of req) raw += part;
		n += 1;
		const body = raw ? JSON.parse(raw) : undefined;
		bodies.push(body);
		await handler({ n, body, res });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}`,
		bodies,
		count: () => n,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export function sseHead(res: http.ServerResponse): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

export function sseChunk(res: http.ServerResponse, delta: object, finish: string | null = null): void {
	const chunk = {
		id: "chatcmpl-mock",
		object: "chat.completion.chunk",
		created: 0,
		model: "mock",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
	res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export function sseDone(res: http.ServerResponse): void {
	const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
	res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [], usage })}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}

/** A complete, successful streamed text reply. */
export function sseText(res: http.ServerResponse, text: string): void {
	sseHead(res);
	sseChunk(res, { role: "assistant", content: text });
	sseChunk(res, {}, "stop");
	sseDone(res);
}

export function mockProvider(url: string) {
	const model: Model<"openai-completions"> = {
		id: "mock",
		name: "Mock",
		api: "openai-completions",
		provider: "mock",
		baseUrl: url,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
	const provider = createProvider({
		id: "mock",
		name: "Mock",
		baseUrl: url,
		auth: { apiKey: { name: "Mock", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		models: [model],
		api: openAICompletionsApi(),
	});
	return { model, provider };
}
