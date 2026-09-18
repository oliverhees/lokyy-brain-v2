// Response shapes of the portal API (src/server/app.ts).
export type Role = 'reader' | 'writer';

export interface Session {
  username: string;
  isAdmin: boolean;
  csrfToken: string;
  hasAccess: boolean;
  setupComplete: boolean;
  companyName: string | null;
  package?: string | null;
}

export interface UserRow {
  slot: string;
  username: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'invited' | 'active' | 'disabled';
  provisioning: ProvisioningState;
  invitedAt: string;
  activatedAt: string | null;
}

export type ProvisioningState = 'pending' | 'ok' | 'failed';
export interface ProvisioningRun { state: ProvisioningState; at: string | null; error: string | null; restartMetamcp: boolean }
export interface Route { id: string; name: string }
export interface VaultLlm { keyHint: string; ruleId: string; ruleName: string }

export interface UsersResponse {
  users: UserRow[];
  retired: { slot: string; formerUsername: string; retiredAt: string }[];
  freeSlots: number;
  lastProvisioning: ProvisioningRun | null;
}

export interface InviteResponse { user: UserRow; inviteLink: string; mailed: boolean; mailError?: boolean }

export interface SetupStatus {
  company: { name: string } | null;
  llm: { mode: 'shared' | 'per-vault'; model: string | null; vaults: Record<string, VaultLlm>; baseUrl: string } | null;
  smtp: { host: string; port: number; secure: boolean; username: string; from: string; passwordSet: boolean } | null;
  setupCompletedAt: string | null;
  vaults: string[];
  slots: { total: number; free: number };
  package: string | null;
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
  provisioning: ProvisioningState;
}

export interface AuditEntry { at: string; actor: string; action: string; target?: string }
