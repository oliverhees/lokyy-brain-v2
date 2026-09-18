// Copy-paste configuration for MCP clients (format of deploy/stack/README.md "Connect an MCP client").

export const KEY_PLACEHOLDER = '<API-SCHLÜSSEL>';

export interface SnippetInput {
  name: string;
  url: string;
  /** null while the key is hidden: the snippet then shows a placeholder */
  apiKey: string | null;
}

export function claudeCodeCommand({ name, url, apiKey }: SnippetInput): string {
  return `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${apiKey ?? KEY_PLACEHOLDER}"`;
}

export function claudeDesktopConfig({ name, url, apiKey }: SnippetInput): string {
  return JSON.stringify({ mcpServers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer ${apiKey ?? KEY_PLACEHOLDER}` } } } }, null, 2);
}
