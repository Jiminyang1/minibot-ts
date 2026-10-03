// Golden evals: cases in git (evals/cases.json), mirrored to a Langfuse
// dataset, scored per stage. With Langfuse configured a run is a Langfuse
// experiment: each case's trace nests under its dataset item with the scores
// attached, so runs can be compared after a prompt, skill, or model change.
// Without it (or with --local) the same scores are printed and saved under
// $MINIBOT_HOME/evals/.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { LangfuseClient } from "@langfuse/client";
import type { Config } from "../config.ts";
import { type CaseInput, runCase } from "./sandbox.ts";
import { type CaseOutput, endToEnd, type Expected, judgeAnswer, scoreDeterministic, type StageScore } from "./scoring.ts";

export const DATASET = "minibot-golden";
const CASES_PATH = fileURLToPath(new URL("../../evals/cases.json", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STAGES = ["skill_selection", "tool_selection", "tool_args", "answer", "outcome", "end_to_end"] as const;

export interface GoldenCase {
	id: string;
	category: string;
	description: string;
	input: CaseInput;
	expected: Expected;
}

export interface CaseRow {
	case: string;
	output: CaseOutput;
	scores: Record<string, { value: number; comment: string }>;
}

export function loadCases(ids: string[] = []): GoldenCase[] {
	const cases = JSON.parse(readFileSync(CASES_PATH, "utf8")) as GoldenCase[];
	const known = new Set(cases.map((item) => item.id));
	if (known.size !== cases.length) throw new Error("cases.json 里有重复的用例 id。");
	const unknown = ids.filter((id) => !known.has(id));
	if (unknown.length) throw new Error(`未知用例: ${unknown.join(", ")}`);
	return ids.length ? cases.filter((item) => ids.includes(item.id)) : cases;
}

export interface Judge {
	models: Models;
	model: Model<Api>;
}

/** All stage scores for one run, end_to_end last, then cost and latency. */
export async function evaluate(output: CaseOutput, input: CaseInput, expected: Expected, judge: Judge | undefined, today = new Date()): Promise<StageScore[]> {
	const scores = scoreDeterministic(output, expected, today);
	if (expected.answerRubric && judge) scores.push(await judgeAnswer(judge.models, judge.model, input.prompt, output, expected.answerRubric));
	scores.push(endToEnd(scores, output.error));
	scores.push(
		{ name: "model_calls", value: output.modelCalls, comment: "" },
		{ name: "tokens", value: output.inputTokens + output.outputTokens, comment: "" },
		{ name: "latency_s", value: output.elapsedS, comment: "" },
	);
	return scores;
}

function row(id: string, output: CaseOutput, scores: StageScore[]): CaseRow {
	return { case: id, output, scores: Object.fromEntries(scores.map((score) => [score.name, { value: score.value, comment: score.comment }])) };
}

export function gitRevision(): string {
	try {
		const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
		return dirty ? `${sha}-dirty` : sha;
	} catch {
		return "unknown";
	}
}

export async function runLocal(config: Config, judge: Judge, ids: string[], name: string, log: (line: string) => void): Promise<CaseRow[]> {
	const rows: CaseRow[] = [];
	for (const item of loadCases(ids)) {
		log(`… ${item.id}`);
		const output = await runCase(item.input, config);
		rows.push(row(item.id, output, await evaluate(output, item.input, item.expected, judge)));
	}
	const dir = join(config.home, "evals");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.json`);
	writeFileSync(path, JSON.stringify({ run: name, model: `${config.provider}/${config.modelId}`, git: gitRevision(), results: rows }, null, 2));
	log(`结果已保存: ${path}`);
	return rows;
}

/** Upsert every case into the dataset; archive items no longer in cases.json. */
export async function syncDataset(client: LangfuseClient, cases: GoldenCase[]): Promise<number> {
	let existing: { id: string; status?: string }[] = [];
	try {
		existing = (await client.dataset.get(DATASET)).items;
	} catch {
		await client.api.datasets.create({ name: DATASET, description: "MiniBot golden cases (source of truth: evals/cases.json)" });
	}
	const wanted = new Set(cases.map((item) => `${DATASET}--${item.id}`));
	for (const item of cases) {
		await client.api.datasetItems.create({
			datasetName: DATASET,
			id: `${DATASET}--${item.id}`,
			input: item.input,
			expectedOutput: item.expected,
			metadata: { caseId: item.id, category: item.category, description: item.description },
		});
	}
	for (const item of existing) {
		if (!wanted.has(item.id) && item.status !== "ARCHIVED") {
			await client.api.datasetItems.create({ datasetName: DATASET, id: item.id, status: "ARCHIVED" });
		}
	}
	return cases.length;
}

export async function runExperiment(client: LangfuseClient, config: Config, judge: Judge, ids: string[], name: string): Promise<CaseRow[]> {
	const dataset = await client.dataset.get(DATASET);
	const wanted = new Set(ids.map((id) => `${DATASET}--${id}`));
	const items = dataset.items.filter((item) => item.status !== "ARCHIVED" && (wanted.size === 0 || wanted.has(item.id)));
	const result = await client.experiment.run({
		name: DATASET,
		runName: name,
		description: "minibot golden eval",
		metadata: { model: `${config.provider}/${config.modelId}`, git: gitRevision() },
		data: items,
		maxConcurrency: 1,
		task: async (item: { input?: unknown }) => runCase(item.input as CaseInput, config),
		evaluators: [
			async ({ input, output, expectedOutput }: { input: unknown; output: unknown; expectedOutput?: unknown }) =>
				(await evaluate(output as CaseOutput, input as CaseInput, (expectedOutput ?? {}) as Expected, judge)).map(({ name: scoreName, value, comment }) => ({
					name: scoreName,
					value,
					comment,
				})),
		],
	});
	await client.flush();
	return result.itemResults.map((item) => {
		const meta = (item.item as { metadata?: { caseId?: string } }).metadata;
		return {
			case: meta?.caseId ?? "?",
			output: item.output as CaseOutput,
			scores: Object.fromEntries(item.evaluations.map((evaluation) => [evaluation.name, { value: Number(evaluation.value), comment: evaluation.comment ?? "" }])),
		};
	});
}

/** Visible width: CJK characters take two columns. */
function width(text: string): number {
	let total = 0;
	for (const char of text) total += (char.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
	return total;
}

function mark(value: number, stage: string): string {
	if (stage === "tool_args" && value > 0 && value < 1) return `${Math.round(value * 100)}%`;
	if (stage === "answer") return value >= 1 ? "✓" : value >= 0.5 ? "½" : "✗";
	return value >= 1 ? "✓" : "✗";
}

export function formatTable(rows: CaseRow[]): string {
	const header = ["case", "skill", "tools", "args", "answer", "outcome", "e2e", "calls", "tokens", "s"];
	const totals = new Map<string, number[]>(STAGES.map((stage) => [stage, []]));
	const lines: string[][] = [header];
	for (const item of rows) {
		const cells = [item.case];
		for (const stage of STAGES) {
			const score = item.scores[stage];
			if (!score) {
				cells.push("—");
				continue;
			}
			totals.get(stage)?.push(score.value);
			cells.push(mark(score.value, stage));
		}
		for (const metric of ["model_calls", "tokens", "latency_s"]) cells.push(item.scores[metric] ? String(item.scores[metric].value) : "");
		lines.push(cells);
	}
	lines.push(["平均", ...STAGES.map((stage) => {
		const values = totals.get(stage) ?? [];
		return values.length ? `${Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100)}%` : "—";
	}), "", "", ""]);
	const widths = header.map((_, column) => Math.max(...lines.map((line) => width(line[column] ?? ""))));
	const table = lines.map((line) => line.map((cell, column) => cell + " ".repeat(widths[column] - width(cell))).join("  ")).join("\n");
	const failures = rows.flatMap((item) =>
		STAGES.filter((stage) => stage !== "end_to_end" && item.scores[stage] && item.scores[stage].value < (stage === "answer" ? 0.5 : 1)).map(
			(stage) => `  ${item.case} · ${stage}: ${item.scores[stage].comment}`,
		),
	);
	return failures.length ? `${table}\n\n未通过的阶段:\n${failures.join("\n")}` : table;
}
