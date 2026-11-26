import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ManualEntry } from './ManualEntry';
import { setLang } from '../lib/i18n/index';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));

const onSaved = vi.fn();

beforeEach(() => {
  setLang('en');
  apiMock.mockReset();
  apiMock.mockResolvedValue({});
  onSaved.mockReset();
});

afterEach(() => cleanup());

describe('ManualEntry', () => {
  it('saves a weigh-in with optional body fat and reloads', async () => {
    render(<ManualEntry token="tok" onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '82.5' } });
    fireEvent.change(screen.getByLabelText('Body fat (%)'), { target: { value: '18.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/measurements', {
        method: 'POST',
        token: 'tok',
        body: expect.objectContaining({
          kind: 'WEIGH_IN',
          measuredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          weightKg: 82.5,
          bodyFatPct: 18.4,
        }),
      }),
    );
    expect(await screen.findByText('Measurement saved')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Weight (kg)') as HTMLInputElement).value).toBe('');
  });

  it('saves a blood-pressure reading and omits an empty pulse', async () => {
    render(<ManualEntry token="tok" onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Blood pressure' }));

    fireEvent.change(screen.getByLabelText('Systolic'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('Diastolic'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/measurements', {
        method: 'POST',
        token: 'tok',
        body: expect.objectContaining({
          kind: 'BLOOD_PRESSURE',
          systolicMmhg: 120,
          diastolicMmhg: 80,
        }),
      }),
    );
    const opts = apiMock.mock.calls[0]![1] as { body: Record<string, unknown> };
    expect(opts.body).not.toHaveProperty('pulseBpm');
    expect(onSaved).toHaveBeenCalled();
  });

  it('surfaces API errors and keeps the form values', async () => {
    apiMock.mockRejectedValueOnce(new Error('duplicate measurement'));
    render(<ManualEntry token="tok" onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('duplicate measurement')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Weight (kg)') as HTMLInputElement).value).toBe('80');
  });
});
