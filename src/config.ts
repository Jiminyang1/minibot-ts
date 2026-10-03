// Configuration: environment variables, optionally loaded from $MINIBOT_HOME/.env.
//
// State is global to the user (sessions, memory, schedule live under one home
// directory). The workspace only scopes file and shell tools.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type ApprovalMode = "ask" | "always";

/** A daily window in minutes after local midnight; `end` before `start` wraps past midnight. */
export interface ActiveHours {
	start: number;
	end: number;
}

export interface Config {
	home: string;
	workspace: string;
	provider: string;
	modelId: string;
	thinking: ThinkingLevel;
	/** Output ceiling sent with every request. */
	maxOutputTokens: number;
	/** Overrides the model catalog's context window. */
	contextWindow: number | undefined;
	/** Request size that triggers compaction; defaults to the hard input limit. */
	compactThreshold: number | undefined;
	/** Recent context kept verbatim by compaction. */
	keepRecentTokens: number;
	approval: ApprovalMode;
	/** Model requests per user turn. */
	maxIterations: number;
	/** Retries for a model call that failed before any output arrived. */
	maxRetries: number;
	/** Heartbeats run only inside this window; undefined runs them all day. */
	heartbeatHours: ActiveHours | undefined;
}

export interface Paths {
	home: string;
	env: string;
	sessions: string;
	currentSession: string;
	memory: string;
	schedule: string;
	runs: string;
	mcp: string;
	heartbeat: string;
	evals: string;
	daemonPid: string;
	daemonLog: string;
}

export function paths(home: string): Paths {
	return {
		home,
		env: join(home, ".env"),
		sessions: join(home, "sessions"),
		currentSession: join(home, "current-session"),
		memory: join(home, "memory.json"),
		schedule: join(home, "schedule.json"),
		runs: join(home, "runs.jsonl"),
		mcp: join(home, "mcp.json"),
		heartbeat: join(home, "HEARTBEAT.md"),
		evals: join(home, "evals"),
		daemonPid: join(home, "daemon.pid"),
		daemonLog: join(home, "daemon.log"),
	};
}

function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.MINIBOT_HOME?.trim();
	return resolve(raw ? raw.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".minibot"));
}

/** Copy KEY=VALUE lines from a .env file into `env`; real variables win. */
function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
	if (!existsSync(path)) return;
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line
			.slice(eq + 1)
			.trim()
			.replace(/^(['"])(.*)\1$/, "$2");
		if (env[key] === undefined) env[key] = value;
	}
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export class ConfigError extends Error {
	override name = "ConfigError";
}

/** Read the configuration; `$MINIBOT_HOME/.env` fills in unset variables. */
export function loadConfig(options: { env?: NodeJS.ProcessEnv; workspace?: string } = {}): Config {
	const env = options.env ?? process.env;
	const home = resolveHome(env);
	loadEnvFile(paths(home).env, env);

	const model = (env.MINIBOT_MODEL ?? "deepseek/deepseek-v4-pro").trim();
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) {
		throw new ConfigError(`MINIBOT_MODEL 必须是 provider/model 形式,例如 deepseek/deepseek-v4-pro;收到 "${model}"。`);
	}
	const thinking = (env.MINIBOT_THINKING ?? "medium").trim() as ThinkingLevel;
	if (!THINKING_LEVELS.includes(thinking)) {
		throw new ConfigError(`MINIBOT_THINKING 必须是 ${THINKING_LEVELS.join("/")} 之一。`);
	}
	const approval = (env.MINIBOT_APPROVAL ?? "ask").trim();
	if (approval !== "ask" && approval !== "always") {
		throw new ConfigError("MINIBOT_APPROVAL 必须是 ask 或 always。");
	}

	const config: Config = {
		home,
		workspace: resolve(options.workspace ?? process.cwd()),
		provider: model.slice(0, slash),
		modelId: model.slice(slash + 1),
		thinking,
		maxOutputTokens: positiveInt(env, "MINIBOT_MAX_OUTPUT_TOKENS") ?? 32_000,
		contextWindow: positiveInt(env, "MINIBOT_CONTEXT_WINDOW"),
		compactThreshold: positiveInt(env, "MINIBOT_COMPACT_THRESHOLD"),
		keepRecentTokens: positiveInt(env, "MINIBOT_KEEP_RECENT_TOKENS") ?? 16_000,
		approval,
		maxIterations: positiveInt(env, "MINIBOT_MAX_ITERATIONS") ?? 20,
		maxRetries: nonNegativeInt(env, "MINIBOT_MAX_RETRIES") ?? 3,
		heartbeatHours: parseActiveHours(env.MINIBOT_HEARTBEAT_HOURS),
	};
	if (config.compactThreshold !== undefined && config.keepRecentTokens >= config.compactThreshold) {
		throw new ConfigError("MINIBOT_KEEP_RECENT_TOKENS 必须小于 MINIBOT_COMPACT_THRESHOLD。");
	}
	return config;
}

/** "08:00-23:00" → minutes after midnight; empty means all day. */
export function parseActiveHours(raw: string | undefined): ActiveHours | undefined {
	const text = raw?.trim();
	if (!text) return undefined;
	const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(text);
	const [start, end] = match ? [Number(match[1]) * 60 + Number(match[2]), Number(match[3]) * 60 + Number(match[4])] : [-1, -1];
	if (!match || Number(match[2]) > 59 || Number(match[4]) > 59 || start > 24 * 60 || end > 24 * 60 || start === end) {
		throw new ConfigError(`MINIBOT_HEARTBEAT_HOURS 必须是 HH:MM-HH:MM 形式且起止不同,例如 08:00-23:00;收到 "${text}"。`);
	}
	return { start, end };
}

export function inActiveHours(hours: ActiveHours, date: Date): boolean {
	const minute = date.getHours() * 60 + date.getMinutes();
	return hours.start < hours.end ? minute >= hours.start && minute < hours.end : minute >= hours.start || minute < hours.end;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
	const value = nonNegativeInt(env, name);
	if (value === 0) throw new ConfigError(`${name} 必须大于 0。`);
	return value;
}

function nonNegativeInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
	const raw = env[name]?.trim();
	if (!raw) return undefined;
	if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} 必须是非负整数。`);
	return Number(raw);
}
