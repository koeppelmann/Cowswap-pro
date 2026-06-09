'use client';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="container">
      <div className="panel">
        <h2>Something went wrong</h2>
        <p className="errors">{error?.message || 'Unknown error'}</p>
        {error?.digest && <p className="hint">digest: {error.digest}</p>}
        <div className="actions">
          <button onClick={reset}>Try again</button>
          <button className="ghost" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    </div>
  );
}
