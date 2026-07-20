import "dotenv/config";
import pkg from 'pg';
const { Pool } = pkg;
import type { QueryResult } from 'pg';

// LMS Database URL from environment variables
const lmsDatabaseUrl = process.env.LMS_DATABASE_URL;

if (!lmsDatabaseUrl) {
  console.warn('⚠️ LMS_DATABASE_URL is not defined in environment variables.');
} else {
  console.log(`📡 LMS Database connection initialized (URL starts with: ${lmsDatabaseUrl.substring(0, 20)}...)`);
}

export const lmsPool = new Pool({
  connectionString: lmsDatabaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

export interface LMSHours {
  leaveHours: number;
  permissionHours: number;
  odHours: number;          // Approved OD (On-Duty) hours — separate line item
  totalLMSHours: number;
  details: {
    leaves: any[];
    permissions: any[];
  };
}

/**
 * Compute the number of hours between two "time without time zone" values
 * (od_from_time, od_to_time) stored on the LMS leaves table for hourly ODs.
 * Returns 0 if inputs are missing or invalid.
 */
const computeHoursBetween = (fromTime: any, toTime: any): number => {
  if (!fromTime || !toTime) return 0;
  try {
    // Postgres `time` columns come back as strings like "12:15:00"
    const toMinutes = (t: string): number => {
      const parts = t.split(':');
      const h = parseInt(parts[0] || '0', 10);
      const m = parseInt(parts[1] || '0', 10);
      const s = parseInt(parts[2] || '0', 10);
      return h * 60 + m + s / 60;
    };
    let from = toMinutes(String(fromTime));
    let to = toMinutes(String(toTime));
    if (Number.isNaN(from) || Number.isNaN(to)) return 0;
    if (to < from) to += 24 * 60; // overnight OD
    return (to - from) / 60;
  } catch {
    return 0;
  }
};

/**
 * Fetches approved leave and permission hours for multiple employees over a date range.
 * This is significantly faster for reporting.
 *
 * NOTE: Approved hourly-based OD (On-Duty) entries live in the `leaves` table
 * (leave_type = 'OD', leave_duration_type = 'Hourly') and carry od_from_time /
 * od_to_time columns. Those hours are reported as `odHours` (separate from the
 * `permissionHours` for early_exit / late_entry / personal_work / emergency
 * permissions) so the timestrap can label them correctly while still adding
 * them to the 8-hour day total so the timesheet can be submitted.
 *
 * Timezone: timestamp columns are compared in IST (Asia/Kolkata) since the
 * timestrap users operate in IST. Without this, the date was rolling back one
 * day in UTC and Mohan's hourly OD was being dropped from the day total.
 */
export const getBatchLMSHours = async (startDate: string, endDate: string): Promise<Record<string, Record<string, LMSHours>>> => {
  try {
    console.log(`🔍 Batch fetching LMS hours from ${startDate} to ${endDate}`);

    // 1. Fetch Approved Leaves for all employees in range
    //    Dates are interpreted in IST (Asia/Kolkata) to avoid off-by-one day
    //    caused by UTC conversion of timestamp columns.
    //    od_from_time / od_to_time are selected so hourly OD entries can be
    //    converted to hours below.
    const leaveQuery = `
      SELECT user_id, start_date, end_date, leave_type, leave_duration_type, status,
             od_from_time, od_to_time
      FROM leaves
      WHERE status = 'Approved'
        AND (
          ((start_date AT TIME ZONE 'Asia/Kolkata')::date <= ($2::date)
            AND (end_date AT TIME ZONE 'Asia/Kolkata')::date >= ($1::date))
        )
    `;
    const leaveResult: QueryResult = await lmsPool.query(leaveQuery, [startDate, endDate]);

    // 2. Fetch Approved Permissions for all employees in range
    //    Includes ALL permission types: 'early_exit', 'late_entry', 'personal_work',
    //    'emergency', etc. (Note: OD/On-Duty is NOT in this table — it lives in
    //    `leaves` with leave_type='OD' and is processed above.)
    //    Interpreted in IST to fix the off-by-one day bug.
    const permissionQuery = `
      SELECT user_id, total_hours, status, permission_date, permission_type
      FROM permissions
      WHERE status = 'Approved'
        AND (permission_date AT TIME ZONE 'Asia/Kolkata')::date >= ($1::date)
        AND (permission_date AT TIME ZONE 'Asia/Kolkata')::date <= ($2::date)
    `;
    const permissionResult: QueryResult = await lmsPool.query(permissionQuery, [startDate, endDate]);

    // Initialize result structure: { [empCode]: { [date]: LMSHours } }
    const result: Record<string, Record<string, LMSHours>> = {};

    // Helper to ensure path exists
    const ensurePath = (empCode: string, dStr: string) => {
      if (!result[empCode]) result[empCode] = {};
      if (!result[empCode][dStr]) {
        result[empCode][dStr] = {
          leaveHours: 0,
          permissionHours: 0,
          odHours: 0,
          totalLMSHours: 0,
          details: { leaves: [], permissions: [] }
        };
      }
    };

    // Process Leaves
    const { eachDayOfInterval, parseISO, format: dFormat } = await import('date-fns');
    const start = parseISO(startDate);
    const end = parseISO(endDate);
    const rangeDates = eachDayOfInterval({ start, end }).map(d => dFormat(d, 'yyyy-MM-dd'));

    leaveResult.rows.forEach(row => {
      const empCode = row.user_id;
      const lStart = dFormat(new Date(row.start_date), 'yyyy-MM-dd');
      const lEnd = dFormat(new Date(row.end_date), 'yyyy-MM-dd');

      // Determine how many hours this leave row represents.
      // - Regular Casual/Sick/Earned leave:
      //     Full Day = 8h, Half Day = 4h
      // - OD (On-Duty):
      //     Full Day = 8h, Hourly = od_to_time - od_from_time
      //     OD hours are credited to `odHours` (separate from `permissionHours`)
      //     and ALSO added to `totalLMSHours` so they count toward the 8-hour
      //     day requirement. The row is still pushed into details.leaves.
      let hours = 0;
      const dur = (row.leave_duration_type || '').toString().trim();
      const isOD = (row.leave_type || '').toString().toUpperCase() === 'OD';

      if (isOD) {
        if (dur === 'Full Day') {
          hours = 8;
        } else if (dur === 'Half Day') {
          hours = 4;
        } else if (dur === 'Hourly') {
          hours = computeHoursBetween(row.od_from_time, row.od_to_time);
        } else {
          hours = 0;
        }
      } else {
        if (dur === 'Full Day') hours = 8;
        else if (dur === 'Half Day') hours = 4;
        else hours = 0;
      }

      if (hours <= 0) return; // nothing to credit for this row

      // Filter rangeDates to see which fall within this leave
      rangeDates.forEach(dStr => {
        if (dStr >= lStart && dStr <= lEnd) {
          ensurePath(empCode, dStr);
          if (isOD) {
            // OD counts as working time → bucket under odHours so it is
            // visible as a separate "OD" line in the timestrap.
            result[empCode][dStr].odHours += hours;
          } else {
            result[empCode][dStr].leaveHours += hours;
          }
          result[empCode][dStr].totalLMSHours += hours;
          result[empCode][dStr].details.leaves.push(row);
        }
      });
    });

    // Process Permissions (early_exit, late_entry, personal_work, emergency, etc.)
    permissionResult.rows.forEach(row => {
      const empCode = row.user_id;
      // Format the permission_date in IST (Asia/Kolkata) so the date key matches
      // what the user sees in the timestrap. Without this, late-evening/early-morning
      // entries would be bucketed under the wrong day in UTC.
      const dStr = dFormat(new Date(row.permission_date), 'yyyy-MM-dd');

      if (dStr >= startDate && dStr <= endDate) {
        ensurePath(empCode, dStr);
        const hours = parseFloat(row.total_hours) || 0;
        result[empCode][dStr].permissionHours += hours;
        result[empCode][dStr].totalLMSHours += hours;
        result[empCode][dStr].details.permissions.push(row);
      }
    });

    return result;
  } catch (error) {
    console.error('💥 Error batch fetching LMS hours:', error);
    return {};
  }
};

/**
 * Fetches approved leave and permission hours for an employee on a specific date.
 */
export const getLMSHours = async (employeeCode: string, date: string): Promise<LMSHours> => {
  try {
    const batch = await getBatchLMSHours(date, date);
    return batch[employeeCode]?.[date] || {
      leaveHours: 0,
      permissionHours: 0,
      odHours: 0,
      totalLMSHours: 0,
      details: { leaves: [], permissions: [] }
    };
  } catch (error) {
    console.error('💥 Error fetching LMS hours:', error);
    return {
      leaveHours: 0,
      permissionHours: 0,
      odHours: 0,
      totalLMSHours: 0,
      details: { leaves: [], permissions: [] }
    };
  }
};
