import { useState } from 'react';
import type { ChartChannelConfig, ChartProvider } from '@stridash/types';
import { PROVIDER_CHANNELS, SERIES_CHANNELS } from '../lib/chart-config';
import { t } from '../lib/i18n/index';

export function ChartConfigList({
  provider,
  name,
  config,
  onChange,
}: {
  provider: ChartProvider;
  name: string;
  config: ChartChannelConfig[] | undefined;
  onChange: (provider: ChartProvider, channels: ChartChannelConfig[]) => void;
}) {
  // working list = the saved configuration extended with catalog channels it
  // predates (appended, visible, canonical order); stored keys that no longer
  // exist in the catalog (renamed since) are dropped rather than crashing.
  // Only channels the provider can actually record are offered — the full
  // catalog for providers without a capability entry.
  const capable = new Set<string>(
    (PROVIDER_CHANNELS[provider] ?? SERIES_CHANNELS.map(([key]) => key)) as string[],
  );
  const configured = new Set<string>((config ?? []).map((c) => c.key));
  const items: ChartChannelConfig[] = [
    ...(config ?? []).filter(
      (c) => capable.has(c.key) && SERIES_CHANNELS.some(([key]) => key === c.key),
    ),
    ...SERIES_CHANNELS.filter(([key]) => capable.has(key) && !configured.has(key)).map(([key]) => ({
      key: key as ChartChannelConfig['key'],
      visible: true,
    })),
  ];

  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  /** array-move: the dragged row lands at the target's index (before it when
   * dragging upward, after it when dragging downward) */
  function moveTo(drag: string, target: string): void {
    const from = items.findIndex((i) => i.key === drag);
    const to = items.findIndex((i) => i.key === target);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...items];
    const moved = next.splice(from, 1)[0];
    if (!moved) return;
    next.splice(to, 0, moved);
    onChange(provider, next);
  }

  return (
    <div className="chart-cfg">
      <h4>{name}</h4>
      <ul className="chart-cfg-list">
        {items.map((item) => {
          const meta = SERIES_CHANNELS.find(([key]) => key === item.key)!;
          const dragging = dragKey === item.key;
          const dropping = overKey === item.key;
          return (
            <li
              key={item.key}
              draggable
              onDragStart={(e) => {
                setDragKey(item.key);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.key);
              }}
              onDragOver={(e) => {
                e.preventDefault(); // required for the drop to fire
                if (dragKey && dragKey !== item.key) setOverKey(item.key);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragKey) moveTo(dragKey, item.key);
                setOverKey(null);
                setDragKey(null);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setOverKey(null);
              }}
              className={`chart-cfg-row${dragging ? ' dragging' : ''}${dropping ? ' drop-target' : ''}`}
            >
              <span className="chart-cfg-handle" aria-hidden="true">
                ≡
              </span>
              <label className="chart-cfg-label">
                <input
                  type="checkbox"
                  checked={item.visible}
                  onChange={() =>
                    onChange(
                      provider,
                      items.map((i) => (i.key === item.key ? { ...i, visible: !i.visible } : i)),
                    )
                  }
                />
                {t(meta[1])}
                <span className="muted">{meta[3].trim()}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
