"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ALL_TIME_FROM } from "@/lib/format";

/**
 * Range calendar: pick days, whole months, or whole years.
 *
 * Dates are `YYYY-MM-DD` strings throughout, matching the URL and `today()`
 * (which is UTC). All math goes through UTC so a viewer's timezone never
 * shifts a day.
 */

type Tab = "days" | "months" | "years";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const daysIn = (y: number, m: number) =>
  new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const parse = (s: string) => ({
  y: +s.slice(0, 4),
  m: +s.slice(5, 7) - 1,
  d: +s.slice(8, 10),
});
const clamp = (s: string, max: string) => (s > max ? max : s);

function monthRange(y: number, m: number, max: string): [string, string] {
  return [iso(y, m, 1), clamp(iso(y, m, daysIn(y, m)), max)];
}
function yearRange(y: number, max: string): [string, string] {
  return [iso(y, 0, 1), clamp(iso(y, 11, 31), max)];
}

function label(from: string, to: string, max: string): string {
  if (from <= ALL_TIME_FROM) return "All time";
  const f = parse(from);
  const t = parse(to);
  const fmt = (p: ReturnType<typeof parse>, year: boolean) =>
    `${p.d} ${MONTHS[p.m]}${year ? ` ${p.y}` : ""}`;
  if (from === to) return fmt(f, true);
  const [ys, ye] = yearRange(f.y, max);
  if (f.y === t.y && from === ys && to === ye) return String(f.y);
  const [ms, me] = monthRange(f.y, f.m, max);
  if (f.y === t.y && f.m === t.m && from === ms && to === me)
    return `${MONTHS_LONG[f.m]} ${f.y}`;
  return f.y === t.y
    ? `${fmt(f, false)} – ${fmt(t, true)}`
    : `${fmt(f, true)} – ${fmt(t, true)}`;
}

export function CalendarPopover({
  from,
  to,
  max,
  onPick,
}: {
  from: string;
  to: string;
  max: string;
  onPick: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("days");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState(() => parse(to)); // month shown in the day grid
  const [yearPage, setYearPage] = useState(() => parse(to).y); // months tab year, years tab window end
  const root = useRef<HTMLDivElement>(null);

  const maxP = parse(max);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  function toggle() {
    if (!open) {
      const p = parse(to);
      setView(p);
      setYearPage(p.y);
      setAnchor(null);
      setHover(null);
    }
    setOpen(!open);
  }

  function commit(a: string, b: string) {
    onPick(a <= b ? a : b, a <= b ? b : a);
    setOpen(false);
  }

  function clickDay(d: string) {
    if (!anchor) return setAnchor(d);
    setAnchor(null);
    commit(anchor, d);
  }

  function shiftMonth(delta: number) {
    const t = view.y * 12 + view.m + delta;
    setView({ y: Math.floor(t / 12), m: ((t % 12) + 12) % 12, d: 1 });
  }

  // Cells of the day grid, Monday first. null = leading blank.
  const cells = useMemo(() => {
    const lead = (new Date(Date.UTC(view.y, view.m, 1)).getUTCDay() + 6) % 7;
    return [
      ...Array<null>(lead).fill(null),
      ...Array.from({ length: daysIn(view.y, view.m) }, (_, i) =>
        iso(view.y, view.m, i + 1),
      ),
    ];
  }, [view.y, view.m]);

  const [lo, hi] = anchor ? [anchor, hover ?? anchor].sort() : [from, to];

  const shortcuts: { text: string; range: [string, string] }[] = [
    { text: "This month", range: monthRange(maxP.y, maxP.m, max) },
    {
      text: "Last month",
      range:
        maxP.m === 0
          ? monthRange(maxP.y - 1, 11, max)
          : monthRange(maxP.y, maxP.m - 1, max),
    },
    { text: "This year", range: yearRange(maxP.y, max) },
    { text: "Last year", range: yearRange(maxP.y - 1, max) },
  ];

  const tabBtn = (t: Tab, text: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      onClick={() => setTab(t)}
      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
        tab === t ? "bg-surface-3 text-ink" : "text-ink-2 hover:text-ink"
      }`}
    >
      {text}
    </button>
  );

  const nav = (
    text: string,
    onClick: () => void,
    disabled = false,
    glyph = text,
  ) => (
    <button
      type="button"
      aria-label={text}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-md text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {glyph}
    </button>
  );

  const tile = (active: boolean) =>
    `rounded-md py-2.5 text-sm transition-colors disabled:opacity-30 ${
      active
        ? "bg-brand text-white"
        : "text-ink hover:bg-surface-3 disabled:hover:bg-transparent"
    }`;

  const years = Array.from({ length: 12 }, (_, i) => yearPage - 11 + i);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface-1 px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-3 outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        <svg
          viewBox="0 0 16 16"
          className="size-3.5 text-ink-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden
        >
          <rect x="2" y="3" width="12" height="11" rx="2" />
          <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
        </svg>
        <span className="whitespace-nowrap">{label(from, to, max)}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose date range"
          className="absolute right-0 top-full z-30 mt-2 flex w-[min(21rem,calc(100vw-2rem))] flex-col gap-3 rounded-xl border border-line-strong bg-surface-2 p-3 shadow-2xl sm:w-[26rem] sm:flex-row"
        >
          <div className="grid grid-cols-4 gap-1 sm:flex sm:w-24 sm:shrink-0 sm:flex-col">
            {shortcuts.map((s) => (
              <button
                key={s.text}
                type="button"
                onClick={() => commit(...s.range)}
                className="rounded-md px-2 py-1.5 text-left text-xs text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
              >
                {s.text}
              </button>
            ))}
          </div>

          <div className="min-w-0 flex-1">
            <div
              role="tablist"
              className="mb-2 flex gap-1 rounded-lg bg-surface-1 p-1"
            >
              {tabBtn("days", "Days")}
              {tabBtn("months", "Months")}
              {tabBtn("years", "Years")}
            </div>

            {tab === "days" && (
              <>
                <div className="mb-1 flex items-center justify-between">
                  {nav("Previous year", () => shiftMonth(-12), false, "«")}
                  {nav("Previous month", () => shiftMonth(-1), false, "‹")}
                  <span className="flex-1 text-center text-sm font-semibold">
                    {MONTHS_LONG[view.m]} {view.y}
                  </span>
                  {nav(
                    "Next month",
                    () => shiftMonth(1),
                    view.y * 12 + view.m >= maxP.y * 12 + maxP.m,
                    "›",
                  )}
                  {nav(
                    "Next year",
                    () => shiftMonth(12),
                    (view.y + 1) * 12 + view.m > maxP.y * 12 + maxP.m,
                    "»",
                  )}
                </div>
                <div className="grid grid-cols-7 text-center text-[11px] text-ink-3">
                  {WEEKDAYS.map((w) => (
                    <span key={w} className="py-1">
                      {w}
                    </span>
                  ))}
                </div>
                <div
                  className="grid grid-cols-7"
                  onMouseLeave={() => setHover(null)}
                >
                  {cells.map((d, i) => {
                    if (!d) return <span key={`b${i}`} />;
                    const edge = d === lo || d === hi;
                    const inside = d > lo && d < hi;
                    return (
                      <button
                        key={d}
                        type="button"
                        disabled={d > max}
                        aria-pressed={edge}
                        onClick={() => clickDay(d)}
                        onMouseEnter={() => anchor && setHover(d)}
                        className={`h-8 text-xs transition-colors disabled:opacity-25 ${
                          edge
                            ? "rounded-md bg-brand font-semibold text-white"
                            : inside
                              ? "bg-brand/20 text-ink"
                              : "rounded-md text-ink hover:bg-surface-3 disabled:hover:bg-transparent"
                        } ${d === max && !edge ? "font-bold text-brand" : ""}`}
                      >
                        {+d.slice(8)}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-center text-[11px] text-ink-3">
                  {anchor
                    ? "Now pick the end date"
                    : "Pick a start date, then an end date"}
                </p>
              </>
            )}

            {tab === "months" && (
              <>
                <div className="mb-2 flex items-center justify-between">
                  {nav(
                    "Previous year",
                    () => setYearPage(yearPage - 1),
                    false,
                    "‹",
                  )}
                  <button
                    type="button"
                    onClick={() => commit(...yearRange(yearPage, max))}
                    className="rounded-md px-2 py-1 text-sm font-semibold hover:bg-surface-3"
                    title={`Select all of ${yearPage}`}
                  >
                    {yearPage}
                  </button>
                  {nav(
                    "Next year",
                    () => setYearPage(yearPage + 1),
                    yearPage >= maxP.y,
                    "›",
                  )}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {MONTHS.map((m, i) => {
                    const [ms, me] = monthRange(yearPage, i, max);
                    const future = iso(yearPage, i, 1) > max;
                    const active = from === ms && to === me;
                    return (
                      <button
                        key={m}
                        type="button"
                        disabled={future}
                        onClick={() => commit(ms, me)}
                        className={tile(active)}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-center text-[11px] text-ink-3">
                  Click a month, or the year for all of it
                </p>
              </>
            )}

            {tab === "years" && (
              <>
                <div className="mb-2 flex items-center justify-between">
                  {nav(
                    "Earlier years",
                    () => setYearPage(yearPage - 12),
                    false,
                    "‹",
                  )}
                  <span className="text-sm font-semibold">
                    {years[0]} – {years[11]}
                  </span>
                  {nav(
                    "Later years",
                    () => setYearPage(Math.min(yearPage + 12, maxP.y)),
                    yearPage >= maxP.y,
                    "›",
                  )}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {years.map((y) => {
                    const [ys, ye] = yearRange(y, max);
                    const future = y > maxP.y;
                    return (
                      <button
                        key={y}
                        type="button"
                        disabled={future}
                        onClick={() => commit(ys, ye)}
                        className={tile(from === ys && to === ye)}
                      >
                        {y}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
