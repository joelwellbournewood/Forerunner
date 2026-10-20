/**
 * Small inline SVG charts, no library. One hue per chart (blue for the measured series,
 * neutral for grid, axes and targets; the status tones only for pass/fail), text in the text
 * tokens, thin marks, a hover title on every mark, and a table next to every chart so the
 * numbers are readable without the picture. Dark mode comes from the Tailwind `dark:` variant
 * bound to `<html data-theme>`.
 */

export interface TrendPoint {
  /** Label for the hover title and the x axis (a date or an id). */
  label: string;
  value: number;
}

/** A single-series line with markers; `max` fixes the y range (grades are 0 to 100). */
export function TrendLine({
  points,
  max = 100,
  min = 0,
  target,
  title,
  testId,
  height = 140,
}: {
  points: TrendPoint[];
  max?: number;
  min?: number;
  /** A horizontal reference line, e.g. the accept threshold. */
  target?: { value: number; label: string };
  title: string;
  testId?: string;
  height?: number;
}) {
  const width = 480;
  const pad = { left: 32, right: 12, top: 12, bottom: 24 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const span = max - min || 1;
  const x = (i: number) =>
    pad.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) =>
    pad.top + innerH - ((Math.min(max, Math.max(min, v)) - min) / span) * innerH;
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");
  const ticks = [min, min + span / 2, max];

  return (
    <figure data-testid={testId} className="m-0">
      <figcaption className="text-xs text-neutral-600 dark:text-neutral-400">{title}</figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-1 h-auto w-full max-w-xl"
        role="img"
        aria-label={`${title}: ${points.map((p) => `${p.label} ${p.value}`).join(", ") || "no data"}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(t)}
              y2={y(t)}
              className="stroke-neutral-200 dark:stroke-neutral-800"
              strokeWidth={1}
            />
            <text
              x={pad.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-neutral-500 text-[10px]"
            >
              {Math.round(t)}
            </text>
          </g>
        ))}
        {target ? (
          <g data-testid="trend-target">
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(target.value)}
              y2={y(target.value)}
              className="stroke-neutral-400 dark:stroke-neutral-500"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text
              x={width - pad.right}
              y={y(target.value) - 3}
              textAnchor="end"
              className="fill-neutral-500 text-[10px]"
            >
              {target.label}
            </text>
          </g>
        ) : null}
        {points.length > 1 ? (
          <path
            d={path}
            fill="none"
            className="stroke-blue-600 dark:stroke-blue-400"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ) : null}
        {points.map((p, i) => (
          <circle
            key={`${p.label}-${i.toString()}`}
            cx={x(i)}
            cy={y(p.value)}
            r={4}
            className="fill-blue-600 stroke-white dark:fill-blue-400 dark:stroke-neutral-950"
            strokeWidth={2}
            data-testid="trend-point"
          >
            <title>
              {p.label}: {p.value}
            </title>
          </circle>
        ))}
        {points.length > 0 ? (
          <>
            <text
              x={x(0)}
              y={height - 6}
              textAnchor="start"
              className="fill-neutral-500 text-[10px]"
            >
              {points[0]?.label}
            </text>
            {points.length > 1 ? (
              <text
                x={x(points.length - 1)}
                y={height - 6}
                textAnchor="end"
                className="fill-neutral-500 text-[10px]"
              >
                {points[points.length - 1]?.label}
              </text>
            ) : null}
          </>
        ) : (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            className="fill-neutral-500 text-xs"
          >
            No data yet
          </text>
        )}
      </svg>
    </figure>
  );
}

/**
 * A measured value against a target as one thin bar: the bar is the value, the tick is the
 * target, and the colour says only whether the target was met (status tones, with the word
 * beside it so colour is never the only signal).
 */
export function TargetBar({
  value,
  target,
  format,
  testId,
}: {
  value: number | null;
  /** 0 or null when the target is set by the task itself. */
  target: number | null;
  format: (n: number) => string;
  testId?: string;
}) {
  const max = Math.max(value ?? 0, target ?? 0, 1);
  const width = 160;
  const barW = value === null ? 0 : Math.max(2, Math.round((value / max) * width));
  const targetX = target ? Math.round((target / max) * width) : null;
  const met = value !== null && target ? value <= target : null;
  const tone =
    met === null
      ? "fill-blue-600 dark:fill-blue-400"
      : met
        ? "fill-emerald-600 dark:fill-emerald-400"
        : "fill-red-600 dark:fill-red-400";
  return (
    <span className="inline-flex items-center gap-2" data-testid={testId} data-met={met ?? "n/a"}>
      <svg
        viewBox={`0 0 ${width} 12`}
        width={width}
        height={12}
        role="img"
        aria-label={`${value === null ? "no sample" : format(value)}${target ? ` against ${format(target)}` : ""}`}
      >
        <rect
          x={0}
          y={3}
          width={width}
          height={6}
          rx={3}
          className="fill-neutral-200 dark:fill-neutral-800"
        />
        {value !== null ? (
          <rect x={0} y={3} width={barW} height={6} rx={3} className={tone} />
        ) : null}
        {targetX !== null ? (
          <rect
            x={targetX - 1}
            y={0}
            width={2}
            height={12}
            className="fill-neutral-600 dark:fill-neutral-300"
          />
        ) : null}
        <title>
          {value === null ? "no sample" : format(value)}
          {target ? `; target ${format(target)}` : ""}
        </title>
      </svg>
      <span className="text-xs text-neutral-600 dark:text-neutral-400">
        {met === null ? (target ? "no sample" : "by task") : met ? "met" : "missed"}
      </span>
    </span>
  );
}
