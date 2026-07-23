import pkg from "pg";
const { Pool } = pkg;

/**
 * TimeGuard's tool-usage data lives in a SEPARATE Supabase/Postgres database
 * from TimeStrap's own tables — NOT the same database as `DATABASE_URL`
 * (see server/db.ts). This mirrors how PMS gets its own dedicated `pmsPool`
 * in server/pmsSupabase.ts, rather than reusing TimeStrap's main pool.
 */
const timeguardDatabaseUrl = process.env.TIMEGUARD_DATABASE_URL;

if (!timeguardDatabaseUrl) {
  console.error(
    "⚠️  TIMEGUARD_DATABASE_URL is not set — TimeGuard tool-usage validation will be skipped (fails open) until it is configured."
  );
}

export const timeguardPool = timeguardDatabaseUrl
  ? new Pool({
      connectionString: timeguardDatabaseUrl,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      ssl: {
        rejectUnauthorized: false,
      },
    })
  : null;

if (timeguardDatabaseUrl) {
  const maskedUrl = timeguardDatabaseUrl.replace(/:[^:@]+@/, ":****@");
  console.log(`🔌 TimeGuard Database initialized with host: ${maskedUrl.split("@")[1]?.split("/")[0] || "Unknown"}`);
}

/**
 * Validates the "Tools Used" selected on a timesheet entry against TimeGuard
 * Agent's actual tool-usage logs (table: employee_tool_usage).
 *
 * A tool is considered "actually used" if TimeGuard recorded a usage session
 * for that tool whose [start_time, end_time) window overlaps the timesheet
 * entry's [startTime, endTime) window on the given date, for that employee.
 *
 * Design notes / fail-safe behavior:
 * - Comparison is case-insensitive and trims whitespace, since TimeGuard's
 *   `tool_name` and the timesheet's free-text tool selections may differ in
 *   casing (e.g. "Photoshop" vs "photoshop").
 * - `date` + `startTime`/`endTime` on the timesheet are treated as IST
 *   (Asia/Kolkata, UTC+5:30) — matching how the rest of TimeStrap handles
 *   local times — and converted to UTC instants to compare against
 *   TimeGuard's `timestamptz` columns.
 * - If TimeGuard has ZERO usage rows at all for this employee on this date
 *   (e.g. agent wasn't running, employee was doing field/site work with no
 *   PC involved), validation is SKIPPED rather than blocking submission —
 *   otherwise this would incorrectly block legitimate work that TimeGuard
 *   simply has no visibility into. This preserves existing functionality
 *   for employees/scenarios TimeGuard doesn't cover.
 */

export interface ToolUsageValidationResult {
  valid: boolean;
  /** Tools the user selected that have no matching usage during the window. */
  invalidTools: string[];
  /** Tool names TimeGuard actually recorded during the window (for reference/debugging). */
  actuallyUsedTools: string[];
  /** True if we skipped validation because TimeGuard had no data at all for this employee/date. */
  skippedNoData: boolean;
  message?: string;
}

function istDateTimeToUtcIso(date: string, time: string): string {
  // date: "YYYY-MM-DD", time: "HH:mm" (or "HH:mm:ss")
  const normalizedTime = time.length === 5 ? `${time}:00` : time;
  // Asia/Kolkata is a fixed UTC+5:30 offset (no DST), so this is safe.
  return new Date(`${date}T${normalizedTime}+05:30`).toISOString();
}

export async function validateToolUsage(
  employeeCode: string,
  date: string,
  startTime: string,
  endTime: string,
  toolsUsed: string[] | null | undefined
): Promise<ToolUsageValidationResult> {
  const requestedTools = (toolsUsed || []).map((t) => t.trim()).filter(Boolean);

  if (requestedTools.length === 0 || !employeeCode || !date || !startTime || !endTime) {
    // Nothing selected, or not enough info to validate — nothing to block.
    return { valid: true, invalidTools: [], actuallyUsedTools: [], skippedNoData: false };
  }

  if (!timeguardPool) {
    // TIMEGUARD_DATABASE_URL not configured — fail open rather than block
    // every submission because of a missing env var.
    return { valid: true, invalidTools: [], actuallyUsedTools: [], skippedNoData: true };
  }

  let entryStartUtc: string;
  let entryEndUtc: string;
  try {
    entryStartUtc = istDateTimeToUtcIso(date, startTime);
    entryEndUtc = istDateTimeToUtcIso(date, endTime);
  } catch {
    // If the date/time can't be parsed, don't block submission over it —
    // that's a separate validation concern handled elsewhere.
    return { valid: true, invalidTools: [], actuallyUsedTools: [], skippedNoData: false };
  }

  // First: does TimeGuard have ANY data for this employee on this date at all?
  // If not, we can't meaningfully validate — skip rather than block.
  const anyDataResult = await timeguardPool.query(
    `SELECT 1 FROM employee_tool_usage WHERE employee_code = $1 AND date = $2 LIMIT 1`,
    [employeeCode, date]
  );
  if (anyDataResult.rowCount === 0) {
    return { valid: true, invalidTools: [], actuallyUsedTools: [], skippedNoData: true };
  }

  // Tools actually used during a window overlapping the entry's time range.
  // Overlap condition: usage.start_time < entry.end AND usage.end_time > entry.start
  const usageResult = await timeguardPool.query(
    `SELECT DISTINCT tool_name
     FROM employee_tool_usage
     WHERE employee_code = $1
       AND start_time < $3::timestamptz
       AND end_time > $2::timestamptz`,
    [employeeCode, entryStartUtc, entryEndUtc]
  );

  const actuallyUsedTools: string[] = usageResult.rows.map((r: any) => r.tool_name);
  const actuallyUsedNormalized = new Set(actuallyUsedTools.map((t) => t.trim().toLowerCase()));

  const invalidTools = requestedTools.filter(
    (t) => !actuallyUsedNormalized.has(t.trim().toLowerCase())
  );

  if (invalidTools.length > 0) {
    return {
      valid: false,
      invalidTools,
      actuallyUsedTools,
      skippedNoData: false,
      message:
        invalidTools.length === 1
          ? `The selected tool "${invalidTools[0]}" was not used during the selected time period. Please select only the tools actually used.`
          : `The selected tools (${invalidTools.join(", ")}) were not used during the selected time period. Please select only the tools actually used.`,
    };
  }

  return { valid: true, invalidTools: [], actuallyUsedTools, skippedNoData: false };
}