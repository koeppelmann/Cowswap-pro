'use client';

import { useState } from 'react';
import { type Duration, durationLabel, durationToSeconds } from '../lib/format';

const PRESETS: Duration[] = [
  { value: 30, unit: 'minutes' },
  { value: 1, unit: 'hours' },
  { value: 12, unit: 'hours' },
  { value: 1, unit: 'days' },
  { value: 1, unit: 'weeks' },
  { value: 1, unit: 'months' },
];

/**
 * Single-field duration control: shows the current value; click to open quick
 * presets plus a custom (number + unit) entry. Presets close on pick; the custom
 * row stays open so you can tweak. Click-away closes.
 */
export function DurationPicker({ value, onChange }: { value: Duration; onChange: (d: Duration) => void }) {
  const [open, setOpen] = useState(false);
  const cur = durationToSeconds(value);

  return (
    <div className="durpick">
      <button type="button" className="durpick-btn" onClick={() => setOpen((o) => !o)}>
        <span>{durationLabel(value)}</span>
        <span className="chev">▼</span>
      </button>
      {open && (
        <>
          <div className="durpick-backdrop" onClick={() => setOpen(false)} />
          <div className="durpick-pop">
            <div className="durpick-presets">
              {PRESETS.map((p) => (
                <button
                  key={durationLabel(p)}
                  type="button"
                  className={`durchip ${durationToSeconds(p) === cur ? 'active' : ''}`}
                  onClick={() => { onChange(p); setOpen(false); }}
                >
                  {durationLabel(p)}
                </button>
              ))}
            </div>
            <div className="durpick-custom">
              <span className="tl">Custom</span>
              <input
                className="mini"
                inputMode="decimal"
                value={value.value}
                onChange={(e) => onChange({ ...value, value: Number(e.target.value) || 0 })}
              />
              <select
                className="mini"
                value={value.unit}
                onChange={(e) => onChange({ ...value, unit: e.target.value as Duration['unit'] })}
              >
                <option value="minutes">min</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
                <option value="weeks">weeks</option>
                <option value="months">months</option>
              </select>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
