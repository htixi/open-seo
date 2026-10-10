import { integer, pgTable, real, text } from "drizzle-orm/pg-core";

export const backlinkAutomationBudget = pgTable("backlink_automation_budget", {
  projectId: text("project_id").primaryKey(),
  dayKey: text("day_key").notNull().default(""),
  dayRequests: integer("day_requests").notNull().default(0),
  dayReservedMicros: integer("day_reserved_micros").notNull().default(0),
  weekKey: text("week_key").notNull().default(""),
  weekRequests: integer("week_requests").notNull().default(0),
  monthKey: text("month_key").notNull().default(""),
  monthRequests: integer("month_requests").notNull().default(0),
  monthReservedMicros: integer("month_reserved_micros").notNull().default(0),
});

export const backlinkAutomationRuns = pgTable("backlink_automation_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  target: text("target").notNull(),
  status: text("status").notNull(),
  reservedMicros: integer("reserved_micros").notNull(),
  actualCostUsd: real("actual_cost_usd"),
  errorCode: text("error_code"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});
