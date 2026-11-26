import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Card } from './Card';

afterEach(() => cleanup());

describe('Card', () => {
  it('renders a label and value', () => {
    render(<Card label="Distance" value="12.3 km" />);
    expect(screen.getByText('Distance')).toBeTruthy();
    expect(screen.getByText('12.3 km')).toBeTruthy();
  });

  it('uses an em dash for missing values but keeps falsy numbers', () => {
    const { rerender } = render(<Card label="HR" value={null} />);
    expect(screen.getByText('—')).toBeTruthy();

    rerender(<Card label="HR" value={0} />);
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
  });
});
