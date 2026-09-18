import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, claudeDesktopConfig, KEY_PLACEHOLDER } from './snippets.ts';

const url = 'https://mcp.example.com/metamcp/anna/mcp';

describe('MCP client snippets', () => {
  it('Claude Code: user scope, HTTP transport, key as bearer header', () => {
    expect(claudeCodeCommand({ name: 'lokyy', url, apiKey: 'sk_mt_abc' })).toBe(
      'claude mcp add --scope user --transport http lokyy https://mcp.example.com/metamcp/anna/mcp --header "Authorization: Bearer sk_mt_abc"');
  });

  it('uses a placeholder until the key is revealed', () => {
    expect(claudeCodeCommand({ name: 'lokyy', url, apiKey: null })).toContain(`Bearer ${KEY_PLACEHOLDER}`);
    expect(claudeDesktopConfig({ name: 'lokyy', url, apiKey: null })).toContain(KEY_PLACEHOLDER);
  });

  it('Claude Desktop: mcp-remote bridge (stdio) with the key in an env variable, as documented by mcp-remote', () => {
    const cfg = JSON.parse(claudeDesktopConfig({ name: 'lokyy', url, apiKey: 'sk_mt_abc' }));
    expect(cfg).toEqual({ mcpServers: { lokyy: {
      command: 'npx',
      args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'],
      env: { AUTH_HEADER: 'Bearer sk_mt_abc' },
    } } });
  });
});
