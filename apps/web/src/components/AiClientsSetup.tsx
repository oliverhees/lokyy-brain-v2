// apps/web/src/components/AiClientsSetup.tsx
/// <reference types="vite/client" />
import { useState } from 'react';

// AI clients reach the vault through MetaMCP with a personal API key from the setup
// portal ("Mein Zugang"); the vault itself does not know the user's key or MCP host.
const CLAUDE_CODE_COMMAND =
  'claude mcp add --scope user --transport http lokyy-brain https://mcp.<your-domain>/metamcp/<username>/mcp --header "Authorization: Bearer <api-key>"';

// Optional build-time link to the setup portal, e.g. https://app.<your-domain>.
const DEFAULT_PORTAL_URL = import.meta.env.VITE_LOKYY_PORTAL_URL ?? '';

export function AiClientsSetup({ portalUrl = DEFAULT_PORTAL_URL }: { portalUrl?: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(CLAUDE_CODE_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="pt-2" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="text-[10.5px] tracking-[1px] uppercase font-semibold mb-1.5" style={{ color: 'var(--text-mid)' }}>
        Connect to AI clients
      </div>
      <div className="text-[11px] mb-2.5" style={{ color: 'var(--text-low)' }}>
        Use Lokyy Brain from Claude Desktop, Cursor, Windsurf, Cline, or Claude Code. Your MCP URL and
        personal API key are in the setup portal under <b>Mein Zugang</b>, together with ready-to-paste
        snippets. Example for Claude Code:
      </div>

      <pre
        className="text-[10.5px] font-mono p-2.5 rounded-md whitespace-pre-wrap break-all"
        style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', color: 'var(--text-default)' }}
      >
{CLAUDE_CODE_COMMAND}
      </pre>

      <div className="flex gap-2 mt-2">
        <button
          onClick={copy}
          className="text-[10.5px] px-2.5 py-1.5 rounded-md font-medium"
          style={{ background: 'rgba(255,255,255,0.92)', color: 'var(--text-inverse)' }}
        >
          {copied ? '✓ Copied' : '📋 Copy command'}
        </button>
        {portalUrl && (
          <a
            href={portalUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10.5px] px-2.5 py-1.5 rounded-md inline-flex items-center"
            style={{ border: '1px solid var(--border-default)', color: 'var(--text-default)' }}
          >Open setup portal (Mein Zugang)</a>
        )}
      </div>

      <div className="text-[10.5px] mt-3" style={{ color: 'var(--text-low)' }}>
        Compatible with:
      </div>
      <ul className="text-[10.5px] mt-1 space-y-0.5" style={{ color: 'var(--text-mid)' }}>
        <li>· Claude Desktop</li>
        <li>· Cursor</li>
        <li>· Windsurf</li>
        <li>· Cline</li>
        <li>· Claude Code</li>
      </ul>
    </div>
  );
}
