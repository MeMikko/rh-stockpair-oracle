/**
 * US equity session state for the underlying of a stock token.
 *
 * Chainlink tags every RH stock feed `us_equities_24/5`: the token trades
 * round the clock on-chain, while the underlying market keeps hours. That gap
 * is the whole point of the deviation metric, so the session has to be exact
 * rather than "is it a weekday".
 *
 * Computed from the America/New_York wall clock via Intl, so DST is handled
 * without a tz dependency.
 */

export type Session = 'regular' | 'pre' | 'post' | 'closed';

/** NYSE/Nasdaq full closures. Extend as the calendar is published. */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

/** Early closes: regular session ends 13:00 ET. */
const HALF_DAYS = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
});

interface EtParts { date: string; minutes: number; weekday: string }

function etParts(at: Date): EtParts {
  const p = Object.fromEntries(FMT.formatToParts(at).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour!;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(hour) * 60 + Number(p.minute),
    weekday: p.weekday!,
  };
}

export interface MarketStatus {
  session: Session;
  /** True only for the regular session -- what "market open" means for pricing. */
  isOpen: boolean;
  etDate: string;
  etMinutes: number;
  isHoliday: boolean;
  isWeekend: boolean;
  isHalfDay: boolean;
}

export function marketStatus(at: Date = new Date()): MarketStatus {
  const { date, minutes, weekday } = etParts(at);
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const isHoliday = HOLIDAYS.has(date);
  const isHalfDay = HALF_DAYS.has(date);

  const base = { etDate: date, etMinutes: minutes, isHoliday, isWeekend, isHalfDay };
  if (isWeekend || isHoliday) return { session: 'closed', isOpen: false, ...base };

  const OPEN = 9 * 60 + 30;
  const CLOSE = isHalfDay ? 13 * 60 : 16 * 60;
  const PRE = 4 * 60;
  const POST = isHalfDay ? 17 * 60 : 20 * 60;

  let session: Session = 'closed';
  if (minutes >= OPEN && minutes < CLOSE) session = 'regular';
  else if (minutes >= PRE && minutes < OPEN) session = 'pre';
  else if (minutes >= CLOSE && minutes < POST) session = 'post';

  return { session, isOpen: session === 'regular', ...base };
}
