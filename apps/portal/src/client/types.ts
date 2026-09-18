// Response shapes of the portal API (src/server/app.ts).
export type Role = 'reader' | 'writer';

export interface Session {
  username: string;
  isAdmin: boolean;
  csrfToken: string;
  hasAccess: boolean;
  setupComplete: boolean;
  companyName: string | null;
}

export interface UserRow {
  slot: string;
  username: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'invited' | 'active' | 'disabled';
  provisioning: 'pending' | 'ok' | 'failed';
  invitedAt: string;
  activatedAt: string | null;
}

export interface ProvisioningRun { at: string; status: 'ok' | 'failed'; error?: string; restartMetamcp: boolean }

export interface UsersResponse {
  users: UserRow[];
  retired: { slot: string; formerUsername: string; retiredAt: string }[];
  freeSlots: number;
  lastProvisioning: ProvisioningRun | null;
}

export interface InviteResponse { user: UserRow; inviteLink: string; mailed: boolean; mailError?: boolean }

export interface SetupStatus {
  company: { name: string } | null;
  llm: { mode: 'shared' | 'per-vault'; model: string; keyHints: Record<string, string>; baseUrl: string } | null;
  smtp: { host: string; port: number; secure: boolean; username: string; from: string; passwordSet: boolean } | null;
  setupCompletedAt: string | null;
  vaults: string[];
  slots: { total: number; free: number };
  lastProvisioning: ProvisioningRun | null;
}

export interface MyAccess {
  username: string;
  displayName: string;
  slot: string;
  role: Role;
  companyName: string | null;
  vaultUrl: string;
  companyVaultUrl: string | null;
  mcpUrl: string;
  serverName: string;
  provisioning: 'pending' | 'ok' | 'failed';
}

export interface AuditEntry { at: string; actor: string; action: string; target?: string }
