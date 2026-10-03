// The tool contract and the registry the runtime exposes to the model.

import type { Static, TSchema } from "typebox";
import type { ToolOutput } from "./result.ts";

export interface ToolContext {
	sessionId: string;
	runId: string;
	/** Root for file and shell tools. */
	workspace: string;
	signal: AbortSignal;
}

export interface Tool<P extends TSchema = TSchema> {
	name: string;
	/** Short label for UIs; defaults to the name. */
	label?: string;
	description: string;
	parameters: P;
	source?: "local" | "mcp";
	/** Needs the user's approval before every call. */
	requiresApproval?: boolean;
	/** Safe to run at the same time as other concurrent calls in one batch. */
	concurrent?: boolean;
	execute(args: Static<P>, context: ToolContext): Promise<ToolOutput> | ToolOutput;
}

/** Keeps the parameter type of `execute` tied to the schema. */
export function defineTool<P extends TSchema>(tool: Tool<P>): Tool<P> {
	return tool;
}

export class ToolRegistry {
	readonly #tools = new Map<string, Tool>();

	register(tool: Tool): void {
		this.#tools.set(tool.name, tool as Tool);
	}

	registerAll(tools: readonly Tool[]): void {
		for (const tool of tools) this.register(tool);
	}

	get(name: string): Tool | undefined {
		return this.#tools.get(name);
	}

	has(name: string): boolean {
		return this.#tools.has(name);
	}

	list(): Tool[] {
		return [...this.#tools.values()];
	}
}
