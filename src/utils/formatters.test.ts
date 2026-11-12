import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration } from './formatters';

describe('formatBytes', () => {
  it('formats zero bytes', () => {
    expect(formatBytes(0)).toBe('0 MB');
  });

  it('formats megabytes with default 2 decimals', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(25.5 * 1024 * 1024)).toBe('25.50 MB');
  });

  it('respects custom decimal precision', () => {
    expect(formatBytes(15 * 1024 * 1024, 1)).toBe('15.0 MB');
  });
});

describe('formatDuration', () => {
  it('formats seconds with one decimal place', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(12.345)).toBe('12.3s');
  });
});
