// `minibot-evals`: golden evals against the real model.
//
//   sync                  upsert evals/cases.json into the Langfuse dataset
//   run [--case ID ...]   run cases in the sandbox and score every stage
//       [--name NAME]     run name (default: model-time-gitsha)
//       [--local]         skip Langfuse; save results under $MINIBOT_HOME/evals
//
// Each run calls the configured model for real (a few cents per run).

import { parseArgs } from "node:util";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ConfigError, loadConfig } from "../config.ts";
import { resolveModel } from "../runtime/bootstrap.ts";
import { langfuseConfigured, startTracing } from "../runtime/tracing.ts";
import { errorMessage } from "../util.ts";
import { formatTable, gitRevision, loadCases, runExperiment, runLocal, syncDataset } from "./runner.ts";

const USAGE = "用法: minibot-evals sync | run [--case ID]... [--name NAME] [--local]";

async function main(): Promise<number> {
	let parsed: { values: { case?: string[]; name?: string; local?: boolean }; positionals: string[] };
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: { case: { type: "string", multiple: true }, name: { type: "string" }, local: { type: "boolean" } },
		});
	} catch (error) {
		console.error(`${errorMessage(error)}\n\n${USAGE}`);
		return 2;
	}
	const { values, positionals } = parsed;
	const command = positionals[0];
	if (command !== "sync" && command !== "run") {
		console.error(USAGE);
		return 2;
	}
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig();
	} catch (error) {
		console.error(error instanceof ConfigError ? `配置错误: ${error.message}` : errorMessage(error));
		return 1;
	}
	const useLangfuse = !values.local && langfuseConfigured();
	if (command === "sync") {
		if (!langfuseConfigured()) {
			console.error("未配置 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY。");
			return 1;
		}
		const { LangfuseClient } = await import("@langfuse/client");
		console.log(`已同步 ${await syncDataset(new LangfuseClient(), loadCases())} 个用例到 Langfuse dataset。`);
		return 0;
	}

	const models = builtinModels();
	const judge = { models, model: await resolveModel(models, config) };
	const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
	const name = values.name ?? `${config.modelId}-${stamp}-${gitRevision()}`;
	console.log(`评测 ${name}(模型 ${config.provider}/${config.modelId})`);
	let rows;
	if (useLangfuse) {
		await startTracing();
		const { LangfuseClient } = await import("@langfuse/client");
		const client = new LangfuseClient();
		await syncDataset(client, loadCases());
		rows = await runExperiment(client, config, judge, values.case ?? [], name);
		console.log("Langfuse: Datasets → minibot-golden → Runs 里可以对比各次运行。");
	} else {
		rows = await runLocal(config, judge, values.case ?? [], name, (line) => console.log(line));
	}
	console.log(`\n${formatTable(rows)}`);
	return 0;
}

process.exit(await main());
