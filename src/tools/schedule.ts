// Tools that let the agent schedule its own future runs.

import { Type } from "typebox";
import { nextRun, type ScheduleStore, shortLocal, type TaskKind } from "../scheduler/schedule.ts";
import { failure, success, type ToolOutput } from "./result.ts";
import { defineTool, type Tool } from "./tool.ts";

export function scheduleTools(store: ScheduleStore): Tool[] {
	return [
		defineTool({
			name: "schedule_task",
			description:
				"创建定时任务:到点后由 scheduler daemon 以无人值守方式执行 prompt,结果通过系统通知投递并存为新会话。" +
				"周期任务用 cron(本地时间,5 字段,如每天 8 点 = '0 8 * * *');一次性提醒用 at(本地 ISO 时间,如 '2026-07-07T09:00')。" +
				"cron 与 at 恰好提供一个。prompt 要写成自包含指令——运行时没有当前对话的上下文。" +
				"heartbeat=true 时创建心跳巡逻:按 cron 周期检查 HEARTBEAT.md 清单,每次从干净的上下文开始,只带上次巡逻留下的笔记;没事保持静默,prompt 变为可选的常设指令。",
			// Creating future autonomous runs is a sensitive act.
			requiresApproval: true,
			parameters: Type.Object({
				title: Type.String({ description: "任务短标题" }),
				prompt: Type.String({ description: "到点执行的自包含指令(无人值守,不能依赖当前对话上下文)" }),
				cron: Type.Optional(Type.String({ description: "5 字段 cron 表达式(本地时间),周期任务用" })),
				at: Type.Optional(Type.String({ description: "一次性触发时间,ISO 格式(无时区视为本地时间)" })),
				heartbeat: Type.Optional(Type.Boolean({ description: "创建心跳巡逻任务(需配 cron;通常整个系统一个即可)" })),
			}),
			execute(args, context): ToolOutput {
				if ((args.cron === undefined) === (args.at === undefined)) return failure("invalid_args", "cron 与 at 必须恰好提供一个。");
				if (args.heartbeat && args.cron === undefined) return failure("invalid_args", "heartbeat 任务必须用 cron 提供巡逻周期。");
				if (!args.heartbeat && !args.prompt.trim()) return failure("invalid_args", "prompt 不能为空。");
				const kind: TaskKind = args.heartbeat ? "heartbeat" : args.cron !== undefined ? "cron" : "once";
				try {
					const task = store.add({
						title: args.title,
						prompt: args.prompt,
						kind,
						expr: args.cron ?? args.at ?? "",
						workspace: context.workspace,
					});
					const next = nextRun(task);
					return success(`已创建定时任务 ${task.id}「${task.title}」${next ? `,下次触发: ${shortLocal(next)}` : ""}。`, {
						data: { task_id: task.id, kind: task.kind, expr: task.expr, next_run: next?.toISOString() ?? null },
					});
				} catch (error) {
					return failure("invalid_args", `时间表达式无效: ${(error as Error).message}`);
				}
			},
		}),
		defineTool({
			name: "list_scheduled_tasks",
			description: "查看全部定时任务:id、标题、时间表达式、下次触发、上次运行状态。",
			concurrent: true,
			parameters: Type.Object({}),
			execute(): ToolOutput {
				const tasks = store.list();
				return success(tasks.length ? `共 ${tasks.length} 个定时任务。` : "当前没有定时任务。", {
					data: {
						tasks: tasks.map((task) => ({
							task_id: task.id,
							title: task.title,
							kind: task.kind,
							expr: task.expr,
							enabled: task.enabled,
							next_run: nextRun(task)?.toISOString() ?? null,
							last_run_at: task.lastRunAt,
							last_status: task.lastStatus,
						})),
					},
				});
			},
		}),
		defineTool({
			name: "cancel_scheduled_task",
			description: "取消(删除)一个定时任务。task_id 可用 list_scheduled_tasks 查询。",
			parameters: Type.Object({ task_id: Type.String({ description: "要取消的任务 id" }) }),
			execute(args): ToolOutput {
				if (store.remove(args.task_id)) return success(`已取消定时任务 ${args.task_id}。`, { data: { task_id: args.task_id } });
				return failure("not_found", `未找到定时任务 ${args.task_id}。`, { data: { task_id: args.task_id } });
			},
		}),
	];
}
