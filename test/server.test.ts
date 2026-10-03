import type { AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalBroker } from "../src/runtime/approval.ts";
import type { RuntimeEvent } from "../src/runtime/events.ts";
import { createApp, webAssets } from "../src/server/app.ts";
import { testRuntime } from "./helpers.ts";

const servers: { close(): void }[] = [];
afterEach(() => {
	while (servers.length) servers.pop()?.close();
});

async function start(config = {}) {
	const broker = new ApprovalBroker();
	const test = await testRuntime(config, { approval: broker.handler });
	const server = createApp(test.runtime, broker, await webAssets());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { ...test, broker, base };
}

/** Read an SSE stream until it ends; call `onEvent` for each event. */
async function readEvents(url: string, onEvent: (event: RuntimeEvent) => void = () => {}, headers: Record<string, string> = {}): Promise<RuntimeEvent[]> {
	const response = await fetch(url, { headers });
	const events: RuntimeEvent[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let index: number;
		while ((index = buffer.indexOf("\n\n")) >= 0) {
			const frame = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const data = frame.split("\n").find((line) => line.startsWith("data: "));
			if (!data) continue;
			const event = JSON.parse(data.slice(6)) as RuntimeEvent;
			events.push(event);
			onEvent(event);
		}
	}
	return events;
}

describe("server", () => {
	it("serves the page and the bundled script", async () => {
		const { base } = await start();
		expect(await (await fetch(`${base}/`)).text()).toContain("<title>MiniBot</title>");
		const script = await fetch(`${base}/static/app.js`);
		expect(script.headers.get("content-type")).toContain("javascript");
		expect((await script.text()).length).toBeGreaterThan(1_000);
	});

	it("runs a turn and streams its events", async () => {
		const { base, faux } = await start();
		faux.setResponses([fauxAssistantMessage("网页你好")]);
		const started = await fetch(`${base}/runs`, { method: "POST", body: JSON.stringify({ input: "hi" }) });
		expect(started.status).toBe(202);
		const { runId, sessionId } = (await started.json()) as { runId: string; sessionId: string };
		const events = await readEvents(`${base}/runs/${runId}/events`);
		expect(events.at(-1)?.type).toBe("run.completed");
		const started0 = events.find((event) => event.type === "model.started");
		expect(started0?.payload).toMatchObject({ messages: [] });

		const history = (await (await fetch(`${base}/sessions/${sessionId}/messages`)).json()) as { messages: { role: string; text: string }[] };
		expect(history.messages).toEqual([
			expect.objectContaining({ role: "user", text: "hi" }),
			expect.objectContaining({ role: "assistant", text: "网页你好" }),
		]);
		// Replay after a given seq skips what the client already has.
		const replay = await readEvents(`${base}/runs/${runId}/events`, () => {}, { "last-event-id": String(events.at(-2)?.seq) });
		expect(replay.map((event) => event.type)).toEqual(["run.completed"]);
	});

	it("answers approvals from the browser", async () => {
		const { base, faux } = await start();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "w.txt", content: "web" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("写好了"),
		]);
		const { runId } = (await (await fetch(`${base}/runs`, { method: "POST", body: JSON.stringify({ input: "写文件" }) })).json()) as { runId: string };
		const events = await readEvents(`${base}/runs/${runId}/events`, (event) => {
			if (event.type === "approval.required") {
				void fetch(`${base}/runs/${runId}/approvals/${event.payload.approvalId}`, { method: "POST", body: JSON.stringify({ approved: true }) });
			}
		});
		expect(events.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({ approved: true });
		expect(events.at(-1)?.type).toBe("run.completed");
	});

	it("manages sessions", async () => {
		const { base } = await start();
		const created = (await (await fetch(`${base}/sessions`, { method: "POST", body: "{}" })).json()) as { session: { id: string } };
		const renamed = await fetch(`${base}/sessions/${created.session.id}`, { method: "PATCH", body: JSON.stringify({ title: "新标题" }) });
		expect(((await renamed.json()) as { session: { title: string } }).session.title).toBe("新标题");
		const listed = (await (await fetch(`${base}/sessions`)).json()) as { currentId: string; sessions: { id: string }[] };
		expect(listed.currentId).toBe(created.session.id);
		expect((await fetch(`${base}/sessions/${created.session.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await fetch(`${base}/sessions/${created.session.id}`)).status).toBe(404);
		expect((await fetch(`${base}/runs`, { method: "POST", body: JSON.stringify({ input: "" }) })).status).toBe(400);
	});
});
