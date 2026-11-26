import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChartConfigList } from './ChartConfigList';
import { setLang } from '../lib/i18n/index';
import type { ChartChannelConfig } from '@stridash/types';

beforeEach(() => setLang('en'));
afterEach(() => cleanup());

const row = (label: string): HTMLLIElement => {
  const el = screen.getByText(label).closest('li');
  if (!el) throw new Error(`row not found: ${label}`);
  return el as HTMLLIElement;
};

const keys = (channels: ChartChannelConfig[]): string[] => channels.map((c) => c.key);

describe('ChartConfigList', () => {
  it('renders only the provider-capable channels in canonical order', () => {
    render(<ChartConfigList provider="ZWIFT" name="Zwift" config={undefined} onChange={vi.fn()} />);

    expect(screen.getByText('Zwift')).toBeTruthy();
    expect(screen.getByText('Speed')).toBeTruthy();
    expect(screen.getByText('Heart rate')).toBeTruthy();
    expect(screen.queryByText('Respiration')).toBeNull();
    expect(
      (screen.getByText('Speed').closest('label')!.querySelector('input') as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('toggles a channel and hands the whole list back', () => {
    const onChange = vi.fn();
    render(
      <ChartConfigList provider="ZWIFT" name="Zwift" config={undefined} onChange={onChange} />,
    );

    fireEvent.click(screen.getByText('Speed').closest('label')!.querySelector('input')!);

    expect(onChange).toHaveBeenCalledTimes(1);
    const [provider, channels] = onChange.mock.calls[0] as [string, ChartChannelConfig[]];
    expect(provider).toBe('ZWIFT');
    expect(keys(channels).slice(0, 2)).toEqual(['speedMs', 'hrBpm']);
    expect(channels[0]).toMatchObject({ key: 'speedMs', visible: false });
    expect(channels[1]).toMatchObject({ key: 'hrBpm', visible: true });
  });

  it('reorders rows with HTML5 drag and drop', () => {
    const onChange = vi.fn();
    render(
      <ChartConfigList provider="ZWIFT" name="Zwift" config={undefined} onChange={onChange} />,
    );

    const dataTransfer = { effectAllowed: '', setData: vi.fn() };
    fireEvent.dragStart(row('Heart rate'), { dataTransfer });
    fireEvent.dragOver(row('Speed'), { dataTransfer });
    fireEvent.drop(row('Speed'), { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'hrBpm');
    const [, channels] = onChange.mock.calls[0] as [string, ChartChannelConfig[]];
    expect(keys(channels).slice(0, 3)).toEqual(['hrBpm', 'speedMs', 'powerW']);
  });

  it('drops stale config keys and keeps configured visibility/order', () => {
    render(
      <ChartConfigList
        provider="GARMIN"
        name="Garmin"
        config={[
          { key: 'retiredChannel' as ChartChannelConfig['key'], visible: true },
          { key: 'powerW', visible: false },
          { key: 'speedMs', visible: true },
        ]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText('Retired channel')).toBeNull();
    const power = row('Power').querySelector('input') as HTMLInputElement;
    expect(power.checked).toBe(false);
    // configured channels keep their saved relative order at the top
    const labels = screen
      .getAllByRole('checkbox')
      .map((input) => input.closest('label')?.textContent ?? '');
    expect(labels[0]).toContain('Power');
    expect(labels[1]).toContain('Speed');
  });

  it('ignores a drag that ends on the same row', () => {
    const onChange = vi.fn();
    render(
      <ChartConfigList provider="ZWIFT" name="Zwift" config={undefined} onChange={onChange} />,
    );

    const dataTransfer = { effectAllowed: '', setData: vi.fn() };
    fireEvent.dragStart(row('Speed'), { dataTransfer });
    fireEvent.drop(row('Speed'), { dataTransfer });

    expect(onChange).not.toHaveBeenCalled();
  });
});
