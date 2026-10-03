// Composition root: build every part of the runtime from the configuration.

import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type Config, ConfigError, type Paths, paths } from "../config.ts";
import { McpHost } from "../mcp/host.ts";
import { ScheduleStore } from "../scheduler/schedule.ts";
import { SessionStore } from "../session/store.ts";
import { ArtifactStore, readArtifactTool } from "../tools/artifacts.ts";
import { execTool } from "../tools/exec.ts";
import { fileTools } from "../tools/files.ts";
import { searchHistoryTool } from "../tools/history.ts";
import { macosTools } from "../tools/macos.ts";
import { MemoryStore, memoryTools } from "../tools/memory.ts";
import { scheduleTools } from "../tools/schedule.ts";
import { readSkillTool, SkillRegistry } from "../tools/skills.ts";
import { ToolRegistry } from "../tools/tool.ts";
import { fetchUrlTool, webSearchTool } from "../tools/web.ts";
import { AgentSession } from "./agent-session.ts";
import { type ApprovalHandler, ApprovalPolicy } from "./approval.ts";
import { Compactor } from "./compaction.ts";
import { Budget, ContextBuilder } from "./context.ts";
import type { EventHandler } from "./events.ts";
import { RunLog } from "./run-log.ts";

export const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

export interface Runtime {
	config: Config;
	paths: Paths;
	models: Models;
	model: Model<Api>;
	store: SessionStore;
	memory: MemoryStore;
	schedule: ScheduleStore;
	artifacts: ArtifactStore;
	skills: SkillRegistry;
	tools: ToolRegistry;
	mcp: McpHost;
	context: ContextBuilder;
	budget: Budget;
	compactor: Compactor;
	approval: ApprovalPolicy;
	session: AgentSession;
	/** Startup notes for verbose frontends: MCP warnings, skipped skills. */
	notes: string[];
	close(): Promise<void>;
}

export interface RuntimeOptions {
	approval?: ApprovalHandler;
	/** Model collection; tests pass a faux provider. Default: every built-in provider. */
	models?: Models;
	/** Connect MCP servers (default true). */
	mcp?: boolean;
	/** Extra always-on event subscribers, such as tracing. */
	subscribers?: EventHandler[];
}

/** Find the configured model and fold the config's limits into it. */
export async function resolveModel(models: Models, config: Config): Promise<Model<Api>> {
	const found = models.getModel(config.provider, config.modelId);
	if (!found) {
		const known = models.getModels(config.provider).map((model) => model.id);
		const hint = known.length > 0 ? `可用模型: ${known.slice(0, 12).join(", ")}` : `未知 provider "${config.provider}"`;
		throw new ConfigError(`找不到模型 ${config.provider}/${config.modelId}。${hint}`);
	}
	if (!(await models.checkAuth(config.provider))) {
		throw new ConfigError(`provider ${config.provider} 缺少凭据。请在 ${paths(config.home).env} 里设置它的 API key,例如 DEEPSEEK_API_KEY。`);
	}
	return { ...found, contextWindow: config.contextWindow ?? found.contextWindow };
}

export async function buildRuntime(config: Config, options: RuntimeOptions = {}): Promise<Runtime> {
	const layout = paths(config.home);
	const notes: string[] = [];
	const models = options.models ?? builtinModels();
	const model = await resolveModel(models, config);
	const maxOutputTokens = Math.min(config.maxOutputTokens, model.maxTokens);
	const effective = { ...config, maxOutputTokens };

	const store = new SessionStore({ dir: layout.sessions, currentPath: layout.currentSession, workspace: config.workspace });
	const memory = new MemoryStore(layout.memory);
	const schedule = new ScheduleStore(layout.schedule);
	const artifacts = new ArtifactStore(layout.sessions);
	const skills = SkillRegistry.fromDirectory(SKILLS_DIR, (message) => notes.push(message));

	const tools = new ToolRegistry();
	tools.registerAll([
		...fileTools,
		execTool,
		webSearchTool,
		fetchUrlTool,
		readArtifactTool(artifacts),
		...memoryTools(memory),
		readSkillTool(skills),
		searchHistoryTool(store),
		...scheduleTools(schedule),
		...(platform() === "darwin" ? macosTools : []),
	]);

	const mcp = new McpHost(layout.mcp);
	notes.push(...mcp.warnings);
	if (options.mcp !== false) {
		for (const tool of await mcp.connect()) {
			if (tools.has(tool.name)) notes.push(`MCP 工具名称冲突,已跳过: ${tool.name}`);
			else tools.register(tool);
		}
		for (const status of mcp.status()) if (status.error) notes.push(`MCP server ${status.name} 连接失败: ${status.error}`);
	}

	const context = new ContextBuilder({ memory, skills, tools, workspace: config.workspace });
	const budget = new Budget({ contextWindow: model.contextWindow, maxOutputTokens, compactThreshold: config.compactThreshold });
	if (config.keepRecentTokens >= budget.compactAt) {
		throw new ConfigError(`MINIBOT_KEEP_RECENT_TOKENS (${config.keepRecentTokens}) 必须小于压缩阈值 (${budget.compactAt})。`);
	}
	const compactor = new Compactor({ store, models, model, keepRecentTokens: config.keepRecentTokens, maxOutputTokens });
	const approval = new ApprovalPolicy(config.approval, options.approval);
	const runLog = new RunLog(layout.runs);
	const session = new AgentSession({
		config: effective,
		models,
		model,
		store,
		tools,
		artifacts,
		context,
		budget,
		compactor,
		approval,
		subscribers: [runLog.handle, ...(options.subscribers ?? [])],
	});

	return {
		config: effective,
		paths: layout,
		models,
		model,
		store,
		memory,
		schedule,
		artifacts,
		skills,
		tools,
		mcp,
		context,
		budget,
		compactor,
		approval,
		session,
		notes,
		close: () => mcp.close(),
	};
}
