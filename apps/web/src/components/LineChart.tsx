import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { fmtKm, metersPerUnit, unitLabel } from '../lib/format';
import {
  fmtDay,
  fmtElapsed,
  fmtTick,
  fmtVal,
  niceTicks,
  PointsRadius,
  ZONE_COLORS,
  type Point,
} from '../lib/chart';
import { t } from '../lib/i18n/index';

export function LineChart({
  points,
  color,
  height = 200,
  label,
  unit,
  zoneThresholds,
  xMode = 'time',
}: {
  points: Point[];
  color: string;
  height?: number;
  label?: string;
  unit?: string;
  /** lower bpm bound of zones 2..n (ascending, Infinity allowed) — when set
   * the line is drawn segment-by-segment in the zone colors */
  zoneThresholds?: number[] | null;
  /** which X axis: elapsed time ("time", default) or distance in meters */
  xMode?: 'time' | 'distance';
}) {
  // hover index — declared before the early return so hook counts stay stable
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <div className="empty">{t('chart.noData')}</div>;

  const W = 900;
  const H = height;
  const padL = 52;
  const padR = 14;
  const padT = 14;
  const padB = 42; // room for the date ticks + "date" x-axis title
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs);
  const y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const spanX = Math.max(1e-9, x1 - x0);
  const spanY = Math.max(1e-9, y1 - y0);
  const spanDays = spanX / 86_400_000;
  const toXY = (p: Point): [number, number] => [
    padL + ((p.x - x0) / spanX) * plotW,
    padT + (1 - (p.y - y0) / spanY) * plotH,
  ];
  const path = points
    .map((p, i) => {
      const [x, y] = toXY(p);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const yTicks = niceTicks(y0, y1, 4);
  // distance mode ticks live in unit space (nice numbers), plotted back in meters
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

  // nearest point by pixel distance along the time axis (viewBox units)
  const svgMove = (e: ReactMouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p) continue;
      const d = Math.abs(toXY(p)[0] - mx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  const hp = hover !== null ? points[hover] : undefined;
  const [hx, hy] = hp ? toXY(hp) : [0, 0];
  const tipW = 128;
  const tipH = 36;
  const tipX = hx + 10 + tipW > W - padR ? hx - tipW - 10 : hx + 10;
  const tipY = Math.min(Math.max(hy - tipH - 10, padT), H - padB - tipH);

  /** zone of a bpm value: 0-based (0 = Z1); only when thresholds are given */
  const zoneOf = zoneThresholds
    ? (y: number): number => {
        let k = 0;
        while (k < zoneThresholds.length && y >= (zoneThresholds[k] ?? Infinity)) k++;
        return k;
      }
    : null;
  const zoneColor = (z: number): string =>
    ZONE_COLORS[Math.min(z, ZONE_COLORS.length - 1)] ?? color;

  // zoned line: each sample-span drawn in the zone color of its midpoint,
  // batched into one path per zone
  const zonePaths = zoneOf
    ? (() => {
        const byZone = new Map<number, string[]>();
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1];
          const b = points[i];
          if (!a || !b) continue;
          const [ax, ay] = toXY(a);
          const [bx, by] = toXY(b);
          const z = zoneOf((a.y + b.y) / 2);
          const arr = byZone.get(z) ?? [];
          arr.push(`M${ax.toFixed(1)},${ay.toFixed(1)} L${bx.toFixed(1)},${by.toFixed(1)}`);
          byZone.set(z, arr);
        }
        return [...byZone.entries()]
          .map(([z, parts]) => ({ z, d: parts.join(' '), fill: zoneColor(z) }))
          .sort((p, q) => p.z - q.z);
      })()
    : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label={label}
      onMouseMove={svgMove}
      onMouseLeave={() => setHover(null)}
    >
      {/* horizontal grid + Y tick labels */}
      {yTicks.map((t) => {
        const y = padT + (1 - (t - y0) / spanY) * plotH;
        return (
          <g key={`y${t}`}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} className="chart-grid" />
            <text x={padL - 6} y={y + 3.5} textAnchor="end" className="chart-axis">
              {fmtVal(t)}
            </text>
          </g>
        );
      })}
      {/* X tick labels */}
      {xTickMarks.map((t) => (
        <text
          key={`x${t.x}`}
          x={padL + ((t.x - x0) / spanX) * plotW}
          y={H - padB + 16}
          textAnchor="middle"
          className="chart-axis"
        >
          {t.label}
        </text>
      ))}
      {/* axis titles */}
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
        {isDist
          ? t('chart.axis.distance', { unit: unitLabel() })
          : spanDays < 1.5
            ? t('chart.axis.elapsed')
            : t('chart.axis.date')}
      </text>
      {zonePaths ? (
        zonePaths.map((zp) => (
          <path key={zp.z} d={zp.d} fill="none" stroke={zp.fill} strokeWidth={1.75} />
        ))
      ) : (
        <path d={path} fill="none" stroke={color} strokeWidth={1.75} />
      )}
      {points.length <= 200 &&
        points.map((p, i) => {
          const [x, y] = toXY(p);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={PointsRadius(points.length)}
              fill={zoneOf ? zoneColor(zoneOf(p.y)) : color}
            />
          );
        })}
      {/* hover: crosshair, highlighted point, tooltip with date + value */}
      {hp && (
        <g>
          <line x1={hx} x2={hx} y1={padT} y2={H - padB} className="chart-cross" />
          <circle
            cx={hx}
            cy={hy}
            r={PointsRadius(points.length) + 2.5}
            fill={zoneOf ? zoneColor(zoneOf(hp.y)) : color}
            stroke="#14171f"
            strokeWidth={1.5}
          />
          <g transform={`translate(${tipX},${tipY})`}>
            <rect width={tipW} height={tipH} rx={6} className="chart-tip" />
            <text x={8} y={14} className="chart-tip-date">
              {isDist ? fmtKm(hp.x) : spanDays < 1.5 ? fmtElapsed(hp.x - x0) : fmtDay(hp.x)}
            </text>
            <text x={8} y={28} className="chart-tip-val">
              {fmtVal(hp.y)}
              {unit}
              {zoneOf ? ` · Z${zoneOf(hp.y) + 1}` : ''}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}
