// Copy-paste configuration for MCP clients.
// Claude Code speaks Streamable HTTP natively. Claude Desktop's config file starts stdio servers only, so
// the endpoint is bridged with mcp-remote; the header value comes from an env variable (mcp-remote's
// documented form "Authorization:${AUTH_HEADER}" avoids argument splitting of the space on Windows).

export const KEY_PLACEHOLDER = '<API-SCHLÜSSEL>';

export interface SnippetInput {
  name: string;
  url: string;
  /** null while the key is hidden: the snippet then shows a placeholder */
  apiKey: string | null;
}

export function claudeCodeCommand({ name, url, apiKey }: SnippetInput): string {
  return `claude mcp add --scope user --transport http ${name} ${url} --header "Authorization: Bearer ${apiKey ?? KEY_PLACEHOLDER}"`;
}

export function claudeDesktopConfig({ name, url, apiKey }: SnippetInput): string {
  return JSON.stringify({ mcpServers: { [name]: {
    command: 'npx',
    args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'],
    env: { AUTH_HEADER: `Bearer ${apiKey ?? KEY_PLACEHOLDER}` },
  } } }, null, 2);
}
