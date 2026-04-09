import React from 'react';

const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as const;
type HandleDir = typeof HANDLES[number];

const CURSORS: Record<HandleDir, string> = {
  nw: 'nw-resize', n: 'n-resize',  ne: 'ne-resize',
  w:  'w-resize',                   e:  'e-resize',
  sw: 'sw-resize', s: 's-resize',  se: 'se-resize',
};

export function ResizeHandles() {
  const makeMouseDown = (dir: HandleDir) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.electronAPI.startWindowResize(dir, e.screenX, e.screenY);
    const onMouseUp = () => {
      window.electronAPI.stopWindowResize();
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <>
      {HANDLES.map((dir) => (
        <div
          key={dir}
          className={`resize-handle resize-handle-${dir}`}
          style={{ cursor: CURSORS[dir] }}
          onMouseDown={makeMouseDown(dir)}
        />
      ))}
    </>
  );
}
