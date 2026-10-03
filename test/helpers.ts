// Shared test fixtures: a temp home and workspace, and a runtime driven by
// pi-ai's in-memory faux provider.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach } from "vitest";
import type { Config } from "../src/config.ts";
import { buildRuntime, type Runtime, type RuntimeOptions } from "../src/runtime/bootstrap.ts";
import type { RuntimeEvent } from "../src/runtime/events.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

export function tempDir(prefix = "minibot-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
	const root = tempDir();
	return {
		home: join(root, "home"),
		workspace: join(root, "workspace"),
		provider: "faux",
		modelId: "faux-1",
		thinking: "off",
		maxOutputTokens: 1_000,
		contextWindow: undefined,
		compactThreshold: undefined,
		keepRecentTokens: 200,
		approval: "ask",
		maxIterations: 20,
		maxRetries: 2,
		...overrides,
	};
}

export interface TestRuntime {
	runtime: Runtime;
	faux: FauxProviderHandle;
	events: RuntimeEvent[];
}

export async function testRuntime(config: Partial<Config> = {}, options: RuntimeOptions = {}): Promise<TestRuntime> {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false, contextWindow: 100_000, maxTokens: 4_000 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const events: RuntimeEvent[] = [];
	const resolved = testConfig(config);
	mkdirSync(resolved.workspace, { recursive: true });
	const runtime = await buildRuntime(resolved, {
		models,
		mcp: false,
		...options,
		subscribers: [(event) => events.push(event), ...(options.subscribers ?? [])],
	});
	cleanups.push(() => void runtime.close());
	return { runtime, faux, events };
}

export function eventTypes(events: RuntimeEvent[]): string[] {
	return events.map((event) => event.type).filter((type) => type !== "model.delta");
}
