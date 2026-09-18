import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatInputShell } from './ChatInputShell';
import { useSettings } from '../../store/settings';

// LBV2-30: with an EUrouter route the composer shows the route, not a model switcher.
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
  useSettings.setState({ ruleId: undefined, baseUrl: '' });
});

describe('ChatInputShell with an EUrouter route', () => {
  it('shows the route name as a static label without the model menu', async () => {
    useSettings.setState({ provider: 'openai', baseUrl: 'https://api.eurouter.ai/api/v1', ruleId: '3f1c2b9a-8d4e-4f6a-9b2c-1d2e3f4a5b6c', ruleName: 'EU only' });
    await act(async () => { root.render(<ChatInputShell value="" onChange={() => {}} onSend={() => {}} modelName="EU only" />); });
    const chip = container.querySelector('[data-testid="chat-route-label"]');
    expect(chip?.textContent).toBe('EU only');
    expect(chip?.tagName).not.toBe('BUTTON');
    expect(container.querySelector('[data-testid="chat-model-picker"]')).toBeNull();
  });

  it('keeps the model switcher without a route', async () => {
    useSettings.setState({ provider: 'openai', baseUrl: '', ruleId: undefined });
    await act(async () => { root.render(<ChatInputShell value="" onChange={() => {}} onSend={() => {}} modelName="gpt-4o" />); });
    expect(container.querySelector('[data-testid="chat-model-picker"]')?.textContent).toBe('gpt-4o');
    expect(container.querySelector('[data-testid="chat-route-label"]')).toBeNull();
  });
});
