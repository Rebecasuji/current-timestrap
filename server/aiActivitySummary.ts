import OpenAI from "openai";
import {
  getToolActivitySummary,
  getActivityLogEntries,
  type ToolActivitySummary,
  type ActivityLogEntry,
} from "./toolUsageValidation";

// Reuses the same OpenAI setup already configured for the RAG chat feature
// (see server/rag/ragChat.ts) — same env var, same client pattern.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export interface SuggestWorkSummaryParams {
  employeeCode: string;
  date: string;
  startTime: string;
  endTime: string;
  project?: string;
  taskTitle?: string;
  subTask?: string;
}

export interface SuggestWorkSummaryResult {
  /** Draft for the Description field — always editable, never auto-saved. */
  description: string;
  /** Draft for the Achievements field. */
  achievements: string;
  /** Draft for the "Quantify Your Result" field — only counts grounded in the logs. */
  quantifyResult: string;
  /** True if there was no TimeGuard signal at all (activity_logs + tool usage both empty). */
  noData: boolean;
}

function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "<1m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Builds a compact, factual line-by-line context block from activity_logs
 * entries — this is the real signal (window titles, URLs, file/page names)
 * the AI needs to infer *what work was done*, not just which app was open.
 */
function buildActivityContext(entries: ActivityLogEntry[]): string {
  return entries
    .slice(0, 40)
    .map((e) => {
      const label = e.windowTitle || e.title || e.url || e.website || e.appName;
      const source = e.appName ? ` [${e.appName}]` : "";
      return `- ${label}${source} — ${formatDuration(e.durationSeconds)}`;
    })
    .join("\n");
}

function formatFallbackFromToolSummary(activity: ToolActivitySummary): {
  description: string;
  achievements: string;
  quantifyResult: string;
} {
  if (activity.entries.length === 0) {
    return { description: "", achievements: "", quantifyResult: "" };
  }
  const parts = activity.entries.map((e) => `${e.toolName} (${e.minutes}m)`);
  return {
    description: `Tools used: ${parts.join(", ")}.`,
    achievements: "",
    quantifyResult: "",
  };
}

/**
 * Drafts Description / Achievements / Quantify-Your-Result suggestions from
 * TimeGuard's tracked activity for this employee/date/time-window.
 *
 * Uses activity_logs (window titles, URLs, file/page names) as the primary
 * signal — this is what actually lets the model infer real work ("visitor
 * registration workflow", "access control validation") instead of only
 * being able to report which application was open.
 *
 * The model is explicitly instructed to ground every claim — especially any
 * number in Quantify Your Result — in something actually present in the
 * logs, and to leave a field blank rather than invent specifics it has no
 * basis for. These are always suggestions the employee reviews and edits,
 * never auto-saved as final.
 */
export async function suggestWorkSummaryFromTimeGuard(
  params: SuggestWorkSummaryParams
): Promise<SuggestWorkSummaryResult> {
  const { employeeCode, date, startTime, endTime, project, taskTitle, subTask } = params;

  const [activityEntries, toolActivity] = await Promise.all([
    getActivityLogEntries(employeeCode, date, startTime, endTime),
    getToolActivitySummary(employeeCode, date, startTime, endTime),
  ]);

  if (activityEntries.length === 0) {
    // No rich activity_logs signal — fall back to the plain tool-time
    // summary rather than fabricating a narrative with nothing to ground it.
    if (toolActivity.noData) {
      return { description: "", achievements: "", quantifyResult: "", noData: true };
    }
    const fallback = formatFallbackFromToolSummary(toolActivity);
    return { ...fallback, noData: false };
  }

  if (!process.env.OPENAI_API_KEY) {
    const fallback = formatFallbackFromToolSummary(toolActivity);
    return { ...fallback, noData: false };
  }

  const taskContext = [project, taskTitle, subTask].filter(Boolean).join(" / ") || "the selected task";
  const activityContext = buildActivityContext(activityEntries);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You draft timesheet entry text from an employee's tracked window/app/browser activity log. " +
            "You are given window titles, file names, page titles, and URLs that were open during a work session, " +
            "with how long each was open. Infer what work was plausibly being done from these specifics " +
            "(e.g. a window titled 'VisitorRegistrationController.ts — VS Code' implies work on a visitor " +
            "registration feature; a browser tab titled 'Pull Request #42 · api-validation' implies a PR/API " +
            "validation task). Do NOT just restate app names and durations — infer the underlying work.\n\n" +
            "STRICT GROUNDING RULE: only state something if it is directly supported by a specific title, " +
            "filename, URL, or page name in the log. Do not invent outcomes, counts, or specifics that aren't " +
            "traceable to something in the log. If the log is too vague to support a claim, leave that field " +
            "empty or write less rather than guess.\n\n" +
            "Output STRICT JSON only, no markdown, no preamble, with exactly these keys:\n" +
            '{"description": string, "achievements": string, "quantifyResult": string}\n' +
            "- description: 1 sentence (max 30 words), plain factual summary of the work performed.\n" +
            "- achievements: 1 sentence (max 30 words) phrasing the same evidence as completed items " +
            "(e.g. 'Completed X, validated Y, resolved Z'), grounded only in what the log shows.\n" +
            "- quantifyResult: SHORT, e.g. '3 files edited, 2 pages reviewed' — ONLY counts you can " +
            "actually derive by counting distinct titles/files/URLs/PRs/tickets in the log. If you cannot " +
            "ground any number, return an empty string for this field rather than guessing a number.",
        },
        {
          role: "user",
          content: `Task: ${taskContext}\n\nTracked activity during this work window (title/page — duration):\n${activityContext}`,
        },
      ],
      max_tokens: 220,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content?.trim() || "{}";
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    return {
      description: typeof parsed.description === "string" ? parsed.description.trim() : "",
      achievements: typeof parsed.achievements === "string" ? parsed.achievements.trim() : "",
      quantifyResult: typeof parsed.quantifyResult === "string" ? parsed.quantifyResult.trim() : "",
      noData: false,
    };
  } catch (error) {
    console.error("[AI-ACTIVITY-SUMMARY] OpenAI call failed, falling back to plain sentence:", error);
    const fallback = formatFallbackFromToolSummary(toolActivity);
    return { ...fallback, noData: false };
  }
}