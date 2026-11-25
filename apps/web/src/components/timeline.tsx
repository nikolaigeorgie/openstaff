import type { HourSummary, MinuteStatus } from "@openstaff/core";
import { worked, type SortedMinute } from "@/lib/report";

const fill: Record<MinuteStatus, string> = {
  active: "var(--active)",
  grace: "var(--grace)",
  claude: "var(--claude)",
  meeting: "var(--meeting)",
  personal: "var(--personal)",
  idle: "var(--idle)",
  paused: "var(--paused)",
};

export const legend: [MinuteStatus | "weak", string][] = [
  ["active", "Typing or clicking"],
  ["grace", "Reading or thinking"],
  ["claude", "Waiting on Claude"],
  ["meeting", "On a call"],
  ["idle", "Idle, not counted"],
  ["paused", "Paused, not counted"],
  ["weak", "Thin evidence"],
];

/** One day as a strip: every minute is a sliver coloured by what backed it up. */
export function Timeline({
  minutes,
  hours,
  fromM,
  toM,
  colors,
}: {
  minutes: SortedMinute[];
  hours: HourSummary[];
  fromM: number;
  toM: number;
  /** Project id to colour. Minutes of a project are drawn in a thin strip under the day. */
  colors?: Map<string, string>;
}) {
  const width = toM - fromM;
  const runs: { x: number; w: number; status: MinuteStatus }[] = [];
  for (const v of minutes) {
    const x = v.m - fromM;
    const last = runs[runs.length - 1];
    if (last && last.status === v.status && last.x + last.w === x) last.w++;
    else runs.push({ x, w: 1, status: v.status });
  }
  const projectRuns: { x: number; w: number; color: string }[] = [];
  for (const v of minutes) {
    if (!worked(v)) continue;
    const color = v.projectId ? colors?.get(v.projectId) ?? "var(--personal)" : v.personal ? "var(--personal)" : null;
    if (!color) continue;
    const x = v.m - fromM;
    const last = projectRuns[projectRuns.length - 1];
    if (last && last.color === color && last.x + last.w === x) last.w++;
    else projectRuns.push({ x, w: 1, color });
  }
  const ticks = Array.from({ length: Math.floor(width / 60) + 1 }, (_, i) => i);
  const label = (h: number) => (h % 24 === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`);
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} 86`}
        className="block h-24 w-full min-w-[640px]"
        preserveAspectRatio="none"
        role="img"
        aria-label="Timeline of the day, one sliver per minute"
      >
        <rect x={0} y={8} width={width} height={44} rx={4} fill="var(--bg)" />
        {runs.map((r) => (
          <rect key={r.x} x={r.x} y={8} width={r.w} height={34} fill={fill[r.status]} />
        ))}
        {projectRuns.map((r) => (
          <rect key={r.x} x={r.x} y={44} width={r.w} height={8} fill={r.color} />
        ))}
        {hours
          .filter((h) => h.evidence === "weak")
          .map((h) => (
            <rect key={h.h} x={h.h * 60 - fromM} y={54} width={60} height={4} fill="var(--weak)" />
          ))}
        {ticks.map((i) => (
          <line key={i} x1={i * 60} x2={i * 60} y1={4} y2={i % 3 === 0 ? 62 : 8} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="relative -mt-5 h-5 min-w-[640px] text-[11px] text-muted">
        {ticks
          .filter((i) => i % 3 === 0 && i < 24)
          .map((i) => (
            <span key={i} className="absolute" style={{ left: `${(i * 60 * 100) / width}%`, paddingLeft: 3 }}>
              {label(i)}
            </span>
          ))}
      </div>
    </div>
  );
}

export function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {legend.map(([key, text]) => (
        <li key={key} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: key === "weak" ? "var(--weak)" : fill[key] }}
          />
          {text}
        </li>
      ))}
    </ul>
  );
}
