import { cn } from '@/lib/utils';

interface SparklineProps {
  points: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Stroke colour overrides the default `var(--accent)`. */
  stroke?: string;
}

/**
 * Tiny inline SVG sparkline — no tooltips, no interactions. Used in
 * KPI cards and agent rows to show 7–8 point trends next to big values.
 * Falls back to a flat line if all points share a value.
 */
export function Sparkline({ points, width = 60, height = 24, className, stroke }: SparklineProps) {
  // Filter non-finite values so a single NaN in the input (e.g. a
  // numeric cast from missing data) does not poison Math.min/max and
  // produce `MNaN,NaN` paths that silently hide the chart.
  const finitePoints = points.filter(Number.isFinite);
  if (finitePoints.length < 2) {
    return null;
  }

  const min = Math.min(...finitePoints);
  const max = Math.max(...finitePoints);
  const range = max - min || 1;

  const path = finitePoints
    .map((p, i) => {
      const x = (i / (finitePoints.length - 1)) * width;
      const y = height - ((p - min) / range) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      role="img"
      aria-label="trend sparkline"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn('opacity-70', className)}
    >
      <title>trend sparkline</title>
      <path
        d={path}
        fill="none"
        stroke={stroke ?? 'var(--accent)'}
        strokeWidth={1.2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
