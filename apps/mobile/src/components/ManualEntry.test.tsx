import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ManualEntry } from './ManualEntry';

const { createMeasurement } = vi.hoisted(() => ({ createMeasurement: vi.fn() }));
vi.mock('@/lib/api', () => ({ createMeasurement }));

const onSaved = vi.fn();

beforeEach(() => {
  createMeasurement.mockReset();
  createMeasurement.mockResolvedValue({ id: 'm1' });
  onSaved.mockReset();
});

afterEach(() => cleanup());

describe('ManualEntry', () => {
  it('saves a weigh-in and clears the inputs', async () => {
    render(<ManualEntry token="tok" onSaved={onSaved} />);

    fireEvent.change(screen.getByPlaceholderText('82.5'), { target: { value: '82.5' } });
    fireEvent.change(screen.getByPlaceholderText('optional'), {
      target: { value: '18.4' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(createMeasurement).toHaveBeenCalledWith('tok', {
        kind: 'WEIGH_IN',
        weightKg: 82.5,
        bodyFatPct: 18.4,
      }),
    );
    expect(await screen.findByText('Measurement saved')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('saves a blood-pressure reading without an empty pulse', async () => {
    render(<ManualEntry token="tok" onSaved={onSaved} />);
    fireEvent.click(screen.getByText('Blood pressure'));

    fireEvent.change(screen.getByPlaceholderText('120'), { target: { value: '120' } });
    fireEvent.change(screen.getByPlaceholderText('80'), { target: { value: '80' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(createMeasurement).toHaveBeenCalledWith('tok', {
        kind: 'BLOOD_PRESSURE',
        systolicMmhg: 120,
        diastolicMmhg: 80,
      }),
    );
  });

  it('shows a save error', async () => {
    createMeasurement.mockRejectedValueOnce(new Error('invalid measurement'));
    render(<ManualEntry token="tok" onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText('82.5'), { target: { value: '80' } });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText('invalid measurement')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
