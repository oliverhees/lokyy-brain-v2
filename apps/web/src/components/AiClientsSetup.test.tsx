import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AiClientsSetup } from './AiClientsSetup';

// LBV2-35: AI clients connect through MetaMCP with a key from the setup portal — never the upstream package.
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

describe('AiClientsSetup', () => {
  it('shows the MetaMCP endpoint with the lokyy-brain key and a bearer placeholder', () => {
    act(() => root.render(<AiClientsSetup />));
    const text = container.textContent ?? '';
    expect(text).toContain('lokyy-brain');
    expect(text).toContain('/metamcp/<username>/mcp');
    expect(text).toContain('Authorization: Bearer <api-key>');
    expect(text).toContain('Mein Zugang');
  });

  it('never points to the upstream package or repository', () => {
    act(() => root.render(<AiClientsSetup />));
    const html = container.innerHTML;
    expect(html).not.toMatch(/frankchu91|@mindbase\/mcp-server|mindbase-mcp|github\.com/);
    expect(html).not.toMatch(/"mindbase"/);
  });

  it('links to the setup portal when its URL is known', () => {
    act(() => root.render(<AiClientsSetup portalUrl="https://app.example.com" />));
    const link = container.querySelector('a[href="https://app.example.com"]');
    expect(link?.textContent).toContain('Mein Zugang');
  });

  it('renders no link when the portal URL is unknown', () => {
    act(() => root.render(<AiClientsSetup portalUrl="" />));
    expect(container.querySelector('a')).toBeNull();
  });
});
