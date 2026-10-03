// MCP servers from $MINIBOT_HOME/mcp.json, exposed as ordinary tools named
// mcp__<server>__<tool>. Tools of untrusted servers need approval.
//
// {
//   "servers": {
//     "drawio": { "command": "npx", "args": ["-y", "@drawio/mcp"] },
//     "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" }, "trusted": true }
//   }
// }

import { McpClient, StdioTransport, StreamableHttpTransport, type CallToolResult, type McpTransport } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { errorMessage, isRecord, readJsonFile } from "../util.ts";
import { failure, success, type ToolOutput } from "../tools/result.ts";
import type { Tool } from "../tools/tool.ts";

export interface ServerConfig {
	name: string;
	enabled: boolean;
	trusted: boolean;
	timeoutMs: number;
	transport:
		| { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string | undefined }
		| { type: "http"; url: string; headers: Record<string, string> };
}

export interface ServerStatus {
	name: string;
	transport: "stdio" | "http";
	enabled: boolean;
	trusted: boolean;
	connected: boolean;
	tools: string[];
	error: string | undefined;
}

const NAME = /^[A-Za-z0-9_-]+$/;

/** Replace ${VAR} with the environment value; a missing variable is an error. */
function substitute(text: string, env: NodeJS.ProcessEnv): string {
	return text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
		const value = env[name];
		if (!value) throw new Error(`环境变量 ${name} 未设置`);
		return value;
	});
}

function stringMap(value: unknown, env: NodeJS.ProcessEnv): Record<string, string> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("必须是对象");
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => {
			if (typeof item !== "string") throw new Error(`${key} 必须是字符串`);
			return [key, substitute(item, env)];
		}),
	);
}

export function parseMcpConfig(raw: unknown, env: NodeJS.ProcessEnv): { servers: ServerConfig[]; warnings: string[] } {
	const servers: ServerConfig[] = [];
	const warnings: string[] = [];
	if (raw === undefined) return { servers, warnings };
	if (!isRecord(raw) || !isRecord(raw.servers)) return { servers, warnings: ["mcp.json 需要一个 servers 对象。"] };
	for (const [name, entry] of Object.entries(raw.servers)) {
		try {
			if (!NAME.test(name)) throw new Error("名称只能包含字母、数字、下划线和短横线");
			if (!isRecord(entry)) throw new Error("必须是对象");
			const enabled = entry.enabled !== false;
			const trusted = entry.trusted === true;
			const timeoutMs = typeof entry.timeoutSeconds === "number" && entry.timeoutSeconds > 0 ? entry.timeoutSeconds * 1000 : 30_000;
			let transport: ServerConfig["transport"];
			if (typeof entry.command === "string") {
				const args = entry.args ?? [];
				if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new Error("args 必须是字符串数组");
				transport = {
					type: "stdio",
					command: enabled ? substitute(entry.command, env) : entry.command,
					args: enabled ? args.map((arg) => substitute(arg, env)) : args,
					env: enabled ? stringMap(entry.env, env) : {},
					cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
				};
			} else if (typeof entry.url === "string") {
				transport = {
					type: "http",
					url: enabled ? substitute(entry.url, env) : entry.url,
					headers: enabled ? stringMap(entry.headers, env) : {},
				};
			} else {
				throw new Error("需要 command(stdio)或 url(Streamable HTTP)");
			}
			servers.push({ name, enabled, trusted, timeoutMs, transport });
		} catch (error) {
			warnings.push(`MCP server ${name} 配置无效,已跳过: ${errorMessage(error)}`);
		}
	}
	return { servers, warnings };
}

/** Provider tool names allow at most 64 characters of [A-Za-z0-9_-]. */
export function mcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export function mcpResultToOutput(label: string, result: CallToolResult): ToolOutput {
	const blocks = result.content ?? [];
	const textOnly = blocks.length > 0 && blocks.every((block) => block.type === "text") && result.structuredContent === undefined;
	const content = textOnly
		? blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n")
		: JSON.stringify({ content: blocks, structured_content: result.structuredContent ?? null }, null, 2);
	const extra = { content, contentKind: textOnly ? ("text" as const) : ("json" as const), contentName: label };
	return result.isError ? failure("error", `${label} 返回错误结果。`, extra) : success(`${label} 已执行。`, extra);
}

export class McpHost {
	readonly configPath: string;
	readonly servers: readonly ServerConfig[];
	readonly warnings: readonly string[];
	readonly #clients = new Map<string, McpClient>();
	readonly #status = new Map<string, ServerStatus>();

	constructor(configPath: string, env: NodeJS.ProcessEnv = process.env) {
		this.configPath = configPath;
		const { servers, warnings } = parseMcpConfig(readJsonFile(configPath), env);
		this.servers = servers;
		this.warnings = warnings;
		for (const server of servers) {
			this.#status.set(server.name, {
				name: server.name,
				transport: server.transport.type,
				enabled: server.enabled,
				trusted: server.trusted,
				connected: false,
				tools: [],
				error: undefined,
			});
		}
	}

	/** Connect every enabled server in parallel; failures are recorded, not thrown. */
	async connect(): Promise<Tool[]> {
		const batches = await Promise.all(this.servers.filter((server) => server.enabled).map((server) => this.#connect(server)));
		return batches.flat();
	}

	status(): ServerStatus[] {
		return [...this.#status.values()];
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.#clients.values()].map((client) => client.close()));
		this.#clients.clear();
	}

	async #connect(server: ServerConfig): Promise<Tool[]> {
		const status = this.#status.get(server.name) as ServerStatus;
		const client = new McpClient({ name: "minibot", version: "0.1.0", requestTimeoutMs: server.timeoutMs });
		try {
			const transport: McpTransport =
				server.transport.type === "stdio"
					? new StdioTransport({
							command: server.transport.command,
							args: server.transport.args,
							env: server.transport.env,
							cwd: server.transport.cwd,
							stderr: "pipe",
						})
					: new StreamableHttpTransport({ url: server.transport.url, headers: server.transport.headers });
			await withTimeout(client.connect(transport), server.timeoutMs, `连接 ${server.name} 超时`);
			const remote = await client.listTools({ timeoutMs: server.timeoutMs });
			this.#clients.set(server.name, client);
			status.connected = true;
			status.tools = remote.map((tool) => tool.name);
			return remote.map((tool) => this.#proxy(server, client, tool));
		} catch (error) {
			status.error = errorMessage(error);
			await client.close().catch(() => {});
			return [];
		}
	}

	#proxy(server: ServerConfig, client: McpClient, remote: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown> }): Tool {
		const label = `${server.name}.${remote.name}`;
		const schema = remote.inputSchema ?? {};
		return {
			name: mcpToolName(server.name, remote.name),
			label,
			description: `[MCP:${server.name}] ${remote.description ?? remote.title ?? remote.name}`,
			parameters: Type.Unsafe({ ...schema, type: "object", properties: schema.properties ?? {} }),
			source: "mcp",
			requiresApproval: !server.trusted,
			async execute(args, context): Promise<ToolOutput> {
				try {
					const result = await client.callTool(remote.name, args as Record<string, unknown>, {
						signal: context.signal,
						timeoutMs: server.timeoutMs,
					});
					return mcpResultToOutput(label, result);
				} catch (error) {
					if (context.signal.aborted) throw context.signal.reason;
					const timedOut = (error as Error).name === "McpTimeoutError";
					return failure(timedOut ? "timeout" : "error", `${label} 调用失败: ${errorMessage(error)}`, {
						data: { server: server.name, remote_tool: remote.name },
					});
				}
			},
		};
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
