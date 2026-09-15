import { useState } from 'react';

/**
 * Brand mark. The logo is served from `public/brand/datasynx-logo.png`; if it is
 * absent (or fails to load) the wordmark alone is rendered rather than a broken
 * image, so deployments without the asset still look intentional.
 */
export function Brand({ size = 20, wordmark = true }: { size?: number; wordmark?: boolean }) {
  const [failed, setFailed] = useState(false);

  return (
    <span className="brand">
      {!failed && (
        <img
          className="brand-logo"
          src="/brand/datasynx-logo.png"
          alt=""
          height={size}
          onError={() => setFailed(true)}
        />
      )}
      {wordmark && <span className="brand-word">DataSynx</span>}
    </span>
  );
}
