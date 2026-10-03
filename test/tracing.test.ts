// The Langfuse subscriber, end to end against a local stand-in for the
// Langfuse OTLP endpoint: nothing leaves the machine.

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { testRuntime } from "./helpers.ts";

interface Span {
	name: string;
	spanId: string;
	traceId: string;
	parentSpanId?: string;
	attributes: { key: string; value: { stringValue?: string } }[];
}

it("exports one trace per run with model, tool, and root observations", async () => {
	const spans: Span[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			if (request.url?.endsWith("/api/public/otel/v1/traces")) {
				const payload = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] };
				for (const resource of payload.resourceSpans) for (const scope of resource.scopeSpans) spans.push(...scope.spans);
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
	process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
	process.env.LANGFUSE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const { runtime, faux } = await testRuntime();
		writeFileSync(join(runtime.config.workspace, "a.txt"), "x");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_file", { path: "a.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const outcome = await runtime.session.prompt(undefined, "read a.txt", { source: "cli" });
		await runtime.close();

		const root = spans.find((span) => span.name === "minibot.turn");
		expect(root).toBeDefined();
		const children = spans.filter((span) => span.parentSpanId === root?.spanId).map((span) => span.name);
		expect(children.sort()).toEqual(["model", "model", "read_file"]);
		expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
		const attribute = (span: Span | undefined, key: string) => span?.attributes.find((item) => item.key === key)?.value.stringValue;
		expect(attribute(root, "session.id")).toBe(outcome.sessionId);
		expect(attribute(spans.find((span) => span.name === "model"), "langfuse.observation.type")).toBe("generation");
		expect(attribute(spans.find((span) => span.name === "read_file"), "langfuse.observation.type")).toBe("tool");
	} finally {
		delete process.env.LANGFUSE_PUBLIC_KEY;
		delete process.env.LANGFUSE_SECRET_KEY;
		delete process.env.LANGFUSE_BASE_URL;
		server.close();
	}
});
