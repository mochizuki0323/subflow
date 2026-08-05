import React from 'react';
import { useResizeHandlePointerDown } from './useWindowGesture';

const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as const;
type HandleDir = typeof HANDLES[number];

const CURSORS: Record<HandleDir, string> = {
  nw: 'nw-resize', n: 'n-resize',  ne: 'ne-resize',
  w:  'w-resize',                   e:  'e-resize',
  sw: 'sw-resize', s: 's-resize',  se: 'se-resize',
};

export function ResizeHandles() {
  const makePointerDown = useResizeHandlePointerDown();

  return (
    <>
      {HANDLES.map((dir) => (
        <div
          key={dir}
          className={`resize-handle resize-handle-${dir}`}
          style={{ cursor: CURSORS[dir] }}
          onPointerDown={makePointerDown(dir)}
        />
      ))}
    </>
  );
}
