// Run the daemon under launchd: a per-user LaunchAgent that starts at login
// and comes back when the process fails.
//
// launchd starts jobs with a bare environment, so the agent carries absolute
// paths (node, the daemon script, the workspace) and the PATH that MCP
// servers launched through npx or uvx need.
//
// The agent must never weigh on the machine: it runs at background priority
// (macOS throttles its CPU and disk use), its heap is capped so a leak ends
// in a restart instead of swapping, launchd restarts it at most once a
// minute, and on shutdown it gets time to close its work cleanly.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AGENT_LABEL = "local.minibot.daemon";
const MAX_HEAP_MB = 512;

export interface AgentSpec {
	node: string;
	script: string;
	workspace: string;
	log: string;
	env: Record<string, string>;
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const string = (text: string) => `<string>${escapeXml(text)}</string>`;

export function agentPlist(spec: AgentSpec): string {
	const env = Object.entries(spec.env).map(([key, value]) => `\t\t<key>${escapeXml(key)}</key>${string(value)}`);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		`\t<key>Label</key>${string(AGENT_LABEL)}`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		...[spec.node, `--max-old-space-size=${MAX_HEAP_MB}`, spec.script, "--workspace", spec.workspace].map((arg) => `\t\t${string(arg)}`),
		"\t</array>",
		`\t<key>WorkingDirectory</key>${string(spec.workspace)}`,
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		...env,
		"\t</dict>",
		"\t<key>RunAtLoad</key><true/>",
		"\t<key>ProcessType</key><string>Background</string>",
		"\t<key>ThrottleInterval</key><integer>60</integer>",
		// Time to cancel the running task and flush traces before launchd kills the process.
		"\t<key>ExitTimeOut</key><integer>20</integer>",
		// Restart only after a failure: a clean exit (stopped, or another daemon already running) stays down.
		"\t<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
		`\t<key>StandardOutPath</key>${string(spec.log)}`,
		`\t<key>StandardErrorPath</key>${string(spec.log)}`,
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

export function agentPath(): string {
	return join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

const domain = () => `gui/${process.getuid?.() ?? 0}`;
const service = () => `${domain()}/${AGENT_LABEL}`;

function isLoaded(): boolean {
	try {
		execFileSync("launchctl", ["print", service()], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Stop the agent if it is loaded and wait until launchd has let go of it; true when it was loaded. */
export async function stopAgent(): Promise<boolean> {
	if (!isLoaded()) return false;
	try {
		execFileSync("launchctl", ["bootout", service()], { stdio: "ignore" });
	} catch {
		// Already on its way out; the wait below settles it.
	}
	// Loading the same label again before launchd finishes fails with "Bootstrap failed: 5".
	for (let waited = 0; isLoaded(); waited += 250) {
		if (waited >= 15_000) throw new Error(`launchd 没有在 15 秒内停止 ${AGENT_LABEL}。`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return true;
}

/** Write the agent and load it; RunAtLoad starts the daemon right away. */
export function startAgent(spec: AgentSpec): string {
	const path = agentPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, agentPlist(spec), "utf8");
	execFileSync("launchctl", ["bootstrap", domain(), path], { stdio: ["ignore", "ignore", "pipe"] });
	return path;
}

/** Unload and delete the agent; false when it was not installed. */
export async function removeAgent(): Promise<boolean> {
	const path = agentPath();
	const loaded = await stopAgent();
	if (!existsSync(path)) return loaded;
	rmSync(path);
	return true;
}
