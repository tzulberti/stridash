import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { fmtKm, metersPerUnit, unitLabel } from '../lib/format';
import {
  COMPARE_A,
  COMPARE_B,
  fmtDay,
  fmtElapsed,
  fmtTick,
  fmtVal,
  niceTicks,
  type Point,
} from '../lib/chart';
import { t } from '../lib/i18n/index';

/** Two-series overlay for the activity-compare section: shared axes across
 * both activities, two polylines (A/B), no hover — v1 stays read-only.
 * xMode mirrors LineChart (elapsed time, or meters when both sides carry a
 * distance stream). */
export function CompareChart({
  a,
  b,
  label,
  unit,
  nameA,
  nameB,
  xMode = 'time',
  height = 180,
}: {
  a: Point[];
  b: Point[];
  label?: string;
  unit?: string;
  /** short activity names for the tooltip lines (identity of each color) */
  nameA?: string;
  nameB?: string;
  /** which X axis: elapsed time (default) or distance in meters */
  xMode?: 'time' | 'distance';
  height?: number;
}) {
  // cursor x in data space — declared before the early return so hook counts
  // stay stable across renders with and without data
  const [hoverX, setHoverX] = useState<number | null>(null);
  if (a.length < 2 || b.length < 2) return <div className="empty">{t('chart.noData')}</div>;

  const W = 900;
  const H = height;
  const padL = 52;
  const padR = 14;
  const padT = 14;
  const padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // combined domain so both lines live in one coordinate space
  const all = [...a, ...b];
  const x0 = Math.min(...all.map((p) => p.x)),
    x1 = Math.max(...all.map((p) => p.x));
  const y0 = Math.min(...all.map((p) => p.y)),
    y1 = Math.max(...all.map((p) => p.y));
  const spanX = Math.max(1e-9, x1 - x0);
  const spanY = Math.max(1e-9, y1 - y0);
  const spanDays = spanX / 86_400_000;
  const toXY = (p: Point): [number, number] => [
    padL + ((p.x - x0) / spanX) * plotW,
    padT + (1 - (p.y - y0) / spanY) * plotH,
  ];
  const pathOf = (pts: Point[]): string =>
    pts
      .map((p, i) => {
        const [x, y] = toXY(p);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const yTicks = niceTicks(y0, y1, 4);
  const isDist = xMode === 'distance';
  const unitM = metersPerUnit();
  const xTickCount = Math.max(2, Math.round(plotW / 170));
  const xTickMarks = isDist
    ? niceTicks(x0 / unitM, x1 / unitM, Math.max(3, Math.round(plotW / 160))).map((d) => ({
        x: d * unitM,
        label: fmtVal(d),
      }))
    : Array.from({ length: xTickCount }, (_, i) => {
        const t = x0 + (spanX * i) / (xTickCount - 1);
        return { x: t, label: fmtTick(t, spanDays, x0) };
      });

  // hover: the sample nearest the cursor's x on EACH series (the two series
  // sample at different clocks, so one shared index can't work)
  const nearest = (pts: Point[], x: number): Point | undefined => {
    let best: Point | undefined;
    let bd = Infinity;
    for (const p of pts) {
      const d = Math.abs(p.x - x);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };
  const svgMove = (e: ReactMouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const dx = x0 + ((mx - padL) / plotW) * spanX;
    setHoverX(Math.min(Math.max(dx, x0), x1));
  };
  const ha = hoverX != null ? nearest(a, hoverX) : undefined;
  const hb = hoverX != null ? nearest(b, hoverX) : undefined;
  const pa = ha ? toXY(ha) : null;
  const pb = hb ? toXY(hb) : null;
  const hx = hoverX != null ? padL + ((hoverX - x0) / spanX) * plotW : 0;
  const tipW = 210;
  const tipH = 86;
  const my = pa && pb ? (pa[1] + pb[1]) / 2 : (pa?.[1] ?? pb?.[1] ?? padT);
  const tipX = hx + 10 + tipW > W - padR ? hx - tipW - 10 : hx + 10;
  const tipY = Math.min(Math.max(my - tipH / 2, padT), H - padB - tipH);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label={label}
      onMouseMove={svgMove}
      onMouseLeave={() => setHoverX(null)}
    >
      {yTicks.map((tv) => {
        const y = padT + (1 - (tv - y0) / spanY) * plotH;
        return (
          <g key={`y${tv}`}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} className="chart-grid" />
            <text x={padL - 6} y={y + 3.5} textAnchor="end" className="chart-axis">
              {fmtVal(tv)}
            </text>
          </g>
        );
      })}
      {xTickMarks.map((tk) => (
        <text
          key={`x${tk.x}`}
          x={padL + ((tk.x - x0) / spanX) * plotW}
          y={H - padB + 16}
          textAnchor="middle"
          className="chart-axis"
        >
          {tk.label}
        </text>
      ))}
      {label && (
        <text
          transform={`rotate(-90 13 ${padT + plotH / 2})`}
          x={13}
          y={padT + plotH / 2}
          textAnchor="middle"
          className="chart-axis-title"
        >
          {label}
        </text>
      )}
      <text x={W - padR} y={H - 6} textAnchor="end" className="chart-axis-title">
        {isDist ? t('chart.axis.distance', { unit: unitLabel() }) : t('chart.axis.elapsed')}
      </text>
      <path d={pathOf(a)} fill="none" stroke={COMPARE_A} strokeWidth={1.75} />
      <path d={pathOf(b)} fill="none" stroke={COMPARE_B} strokeWidth={1.75} />
      {/* hover: crosshair + one highlighted sample per series + tooltip with
          the x label and both values in the series colors */}
      {hoverX != null && (
        <g>
          <line x1={hx} x2={hx} y1={padT} y2={H - padB} className="chart-cross" />
          {pa && (
            <circle
              cx={pa[0]}
              cy={pa[1]}
              r={3.5}
              fill={COMPARE_A}
              stroke="#14171f"
              strokeWidth={1.5}
            />
          )}
          {pb && (
            <circle
              cx={pb[0]}
              cy={pb[1]}
              r={3.5}
              fill={COMPARE_B}
              stroke="#14171f"
              strokeWidth={1.5}
            />
          )}
          <g transform={`translate(${tipX},${tipY})`}>
            <rect width={tipW} height={tipH} rx={6} className="chart-tip" />
            <text x={8} y={14} className="chart-tip-date">
              {isDist ? fmtKm(hoverX) : spanDays < 1.5 ? fmtElapsed(hoverX - x0) : fmtDay(hoverX)}
            </text>
            {/* per series: swatch + name, then the value in the series color
                (inline style — the chart-tip-val class would override a
                fill attribute) */}
            {ha && (
              <>
                <rect x={8} y={22} width={9} height={9} rx={2} fill={COMPARE_A} />
                <text x={22} y={30} className="chart-tip-val">
                  {nameA}
                </text>
                <text x={22} y={44} className="chart-tip-val" style={{ fill: COMPARE_A }}>
                  {fmtVal(ha.y)}
                  {unit}
                </text>
              </>
            )}
            {hb && (
              <>
                <rect x={8} y={54} width={9} height={9} rx={2} fill={COMPARE_B} />
                <text x={22} y={62} className="chart-tip-val">
                  {nameB}
                </text>
                <text x={22} y={76} className="chart-tip-val" style={{ fill: COMPARE_B }}>
                  {fmtVal(hb.y)}
                  {unit}
                </text>
              </>
            )}
          </g>
        </g>
      )}
    </svg>
  );
}
