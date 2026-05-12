import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type MintDayPoint = { date: string; count: number };

const tooltipStyle = {
  background: "var(--panel-solid)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  color: "var(--text)",
};

export function MintTimeseriesLineChart({
  series,
  height = 260,
}: {
  series: MintDayPoint[];
  height?: number;
}) {
  const dense = series.length > 40;
  return (
    <div className="mint-chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ top: 8, right: 12, left: 4, bottom: dense ? 36 : 28 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis
            dataKey="date"
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            tickFormatter={(v: string) => (typeof v === "string" ? v.slice(5) : String(v))}
            angle={dense ? -40 : 0}
            textAnchor={dense ? "end" : "middle"}
            height={dense ? 48 : 32}
            interval="preserveStartEnd"
            label={{ value: "Date (UTC-5)", position: "insideBottom", offset: dense ? -18 : -10, fill: "var(--muted)", fontSize: 11 }}
          />
          <YAxis
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            allowDecimals={false}
            width={40}
            label={{ value: "Mints", angle: -90, position: "insideLeft", fill: "var(--muted)", fontSize: 11 }}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={{ color: "var(--text)" }}
            formatter={(value: number | string) => [value, "Mints"]}
            labelFormatter={(label) => `${label} (UTC-5)`}
          />
          <Line
            type="monotone"
            dataKey="count"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            activeDot={{ r: 4, stroke: "var(--accent)", fill: "var(--panel-solid)" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MintHeatmapGrid({ cells }: { cells: { weekday: number; hour: number; count: number }[] }) {
  const max = Math.max(1, ...cells.map((c) => c.count));
  const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const c of cells) {
    if (c.weekday >= 0 && c.weekday < 7 && c.hour >= 0 && c.hour < 24) grid[c.weekday][c.hour] = c.count;
  }
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="mint-heatmap" role="img" aria-label="Indexed mint events by weekday and hour UTC-5">
      <div className="mint-heatmap__axis-x" aria-hidden>
        <span className="mint-heatmap__corner" />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="mint-heatmap__tick">
            {h % 4 === 0 ? h : ""}
          </span>
        ))}
      </div>
      {grid.map((row, wi) => (
        <div key={wi} className="mint-heatmap__row">
          <span className="mint-heatmap__ylabel">{dayLabels[wi]}</span>
          {row.map((cnt, hi) => (
            <span
              key={hi}
              className="mint-heatmap__cell"
              title={`${dayLabels[wi]} ${hi}:00 UTC-5 — ${cnt} mint(s)`}
              style={{
                background: "var(--accent)",
                opacity: cnt <= 0 ? 0.08 : 0.12 + (0.88 * cnt) / max,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function MintMiniBars({ series }: { series: MintDayPoint[] }) {
  const max = Math.max(1, ...series.map((p) => p.count));
  const peakCount = series.length ? Math.max(...series.map((p) => p.count)) : 0;
  return (
    <div className="mint-mini-bars" aria-hidden>
      {series.map((p) => {
        const isPeak = peakCount > 0 && p.count === peakCount;
        return (
          <div key={p.date} className="mint-mini-bars__cell" title={`${p.date} UTC-5: ${p.count}`}>
            <div
              className={`mint-mini-bars__bar${isPeak ? " mint-mini-bars__bar--peak" : ""}`}
              style={{ height: `${Math.max(4, (p.count / max) * 100)}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}
