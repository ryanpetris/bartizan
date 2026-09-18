import { useLayoutEffect, useState } from 'react';
import type { BrowserTab } from '../shared';
import { targetOf, clearTarget } from './tab-state';
import { Overlay } from './overlay';

/**
 * The address of the link under the pointer, over the page's bottom left corner. It moves to the right corner while
 * the pointer reaches it, so it never covers what the pointer is on.
 */
export function LinkStatus({ tab, visible, area }: { tab: BrowserTab; visible: boolean; area: () => DOMRect | undefined }) {
  const url = visible ? targetOf(tab.id) : '';
  const [side, setSide] = useState<'left' | 'right'>('left');
  // Moving aside uncovers the link, which the page then reports again; the side lasts until the pointer has left links for a while.
  useLayoutEffect(() => {
    if (url) return;
    const timer = setTimeout(() => setSide('left'), 1000);
    return () => clearTimeout(timer);
  }, [url]);
  // A page reports the pointer leaving a link only while it is showing.
  useLayoutEffect(() => () => clearTarget(tab.id), [tab.id]);
  const width = Math.max(0, Math.min(640, Math.floor((area()?.width ?? 0) * 0.6)));
  return (
    <Overlay
      name="status"
      place={(size) => {
        const rect = area();
        if (!url || !rect?.width) return undefined;
        return { x: side === 'left' ? rect.left : rect.right - size.width, y: rect.bottom - size.height, ...size };
      }}
    >
      {url && width > 0 && (
        // On the right the box keeps one width, so its corner stays put as addresses change.
        <div className="link-status-box" data-side={side} style={side === 'right' ? { width } : { maxWidth: width }}>
          <span className="link-status mono" onPointerEnter={() => setSide('right')}>
            {url}
          </span>
        </div>
      )}
    </Overlay>
  );
}
