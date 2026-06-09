'use client';

import { useEffect, useState } from 'react';

/** Debounce a value to avoid firing a request on every keystroke. */
export function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
