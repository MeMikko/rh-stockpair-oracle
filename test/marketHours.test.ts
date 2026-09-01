import { describe, it, expect } from 'vitest';
import { marketStatus } from '../src/pricing/marketHours.js';

const at = (iso: string) => marketStatus(new Date(iso));

describe('marketStatus', () => {
  it('is open mid-session on a normal weekday', () => {
    // 2026-09-02 is a Wednesday. 14:30Z = 10:30 ET (EDT).
    const s = at('2026-09-02T14:30:00Z');
    expect(s.session).toBe('regular');
    expect(s.isOpen).toBe(true);
  });

  it('is closed at the weekend', () => {
    const s = at('2026-09-05T14:30:00Z'); // Saturday
    expect(s.isWeekend).toBe(true);
    expect(s.isOpen).toBe(false);
  });

  it('is closed on Labor Day', () => {
    const s = at('2026-09-07T14:30:00Z');
    expect(s.isHoliday).toBe(true);
    expect(s.session).toBe('closed');
  });

  it('reports pre and post sessions distinctly', () => {
    expect(at('2026-09-02T12:00:00Z').session).toBe('pre');  // 08:00 ET
    expect(at('2026-09-02T21:00:00Z').session).toBe('post'); // 17:00 ET
  });

  it('closes early on a half day', () => {
    // 2026-11-27, 13:30 ET -- after the 13:00 half-day close.
    const s = at('2026-11-27T18:30:00Z');
    expect(s.isHalfDay).toBe(true);
    expect(s.session).toBe('post');
  });

  it('handles the DST boundary in ET', () => {
    // 2026-11-01 DST ends. 14:30Z = 09:30 EST -> exactly the open.
    expect(at('2026-11-02T14:30:00Z').session).toBe('regular');
  });
});
