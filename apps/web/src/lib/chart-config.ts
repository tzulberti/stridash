import type { ChartChannelKey, ChartProvider } from '@stridash/types';
import type { MsgKey } from './i18n/index';

/** labeled stream charts for the activity page, in canonical display order
 * (the user's per-provider Settings configuration overrides this order) */
export const SERIES_CHANNELS: Array<[string, MsgKey, string, string]> = [
  ['speedMs', 'series.speed', '#30a46c', ' m/s'],
  ['hrBpm', 'series.hr', '#e5484d', ' bpm'],
  ['powerW', 'series.power', '#6e56cf', ' W'],
  ['cadenceRpm', 'series.cadence', '#0091ff', ' rpm'],
  ['altitudeM', 'series.altitude', '#b8860b', ' m'],
  ['respirationRate', 'series.respiration', '#d6409f', ' br/min'],
  ['staminaPct', 'series.stamina', '#d29922', ' %'],
  ['stepLengthM', 'series.stepLength', '#80a9a0', ' m'],
  ['verticalOscillationM', 'series.vertOscillation', '#9c6ade', ' m'],
  ['stanceTimePct', 'series.groundContact', '#bf7f26', ' %'],
  ['verticalRatioPct', 'series.vertRatio', '#bf7f26', ' %'],
  ['temperatureC', 'series.temperature', '#f2994a', ' °C'],
];

/** channels each provider's series can actually carry — the Settings lists
 * offer only these per provider and the activity page's no-data hint only
 * mentions them (a provider missing here = the full catalog, e.g. a future
 * Strava). Garmin carries per-record temperature only with a paired Tempe
 * sensor, but the channel stays configurable for it. */
export const PROVIDER_CHANNELS: Partial<Record<ChartProvider, ChartChannelKey[]>> = {
  GARMIN: [
    'speedMs',
    'hrBpm',
    'powerW',
    'cadenceRpm',
    'altitudeM',
    'respirationRate',
    'staminaPct',
    'stepLengthM',
    'verticalOscillationM',
    'stanceTimePct',
    'verticalRatioPct',
    'temperatureC',
  ],
  ZWIFT: ['speedMs', 'hrBpm', 'powerW', 'cadenceRpm', 'altitudeM'],
  IGPSPORT: ['speedMs', 'hrBpm', 'powerW', 'cadenceRpm', 'altitudeM', 'temperatureC'],
};

/** SERIES_CHANNELS reordered + filtered by the provider's saved chart
 * configuration: configured channels follow their saved order and drop out
 * when hidden; channels the configuration doesn't know (catalog entries
 * shipped later) append after, still visible, in canonical order. */
export function orderedChannels(
  provider: string | undefined,
  cfg: Partial<Record<string, Array<{ key: string; visible: boolean }>>> | undefined,
): Array<[string, MsgKey, string, string]> {
  const list = provider ? cfg?.[provider] : undefined;
  if (!list?.length) return SERIES_CHANNELS;
  const pos = new Map(list.map((c, i) => [c.key, i]));
  const vis = new Map(list.map((c) => [c.key, c.visible]));
  return SERIES_CHANNELS.map((ch, i) => ({ ch, i, p: pos.get(ch[0]) }))
    .sort((a, b) => (a.p ?? SERIES_CHANNELS.length + a.i) - (b.p ?? SERIES_CHANNELS.length + b.i))
    .filter((e) => vis.get(e.ch[0]) ?? true)
    .map((e) => e.ch);
}
