'use client';

import { useState } from 'react';

export function AccessNotice() {
  const [visible, setVisible] = useState(true);
  return (
    <div>
      <button onClick={() => setVisible(!visible)}>Toggle notice</button>
      {visible ? <p>Access requires a reader role</p> : <p>Notice hidden</p>}
    </div>
  );
}
