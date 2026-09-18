import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBar } from './StatusBar';

// LBV2-35: no hard-coded upstream data path in the status bar.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const base = { notesCount: 3, wikiCount: 2, modelName: 'EU only', appVersion: '0.1.0' };

describe('StatusBar', () => {
  it('shows no data path when none is given', () => {
    act(() => root.render(<StatusBar {...base} />));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/mindbase/i);
    expect(text).toContain('3 notes');
  });

  it('shows the data path it is given', () => {
    act(() => root.render(<StatusBar {...base} dataPath="/data/lokyy-brain" />));
    expect(container.textContent).toContain('/data/lokyy-brain');
  });
});
