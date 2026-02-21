import type { Event } from 'nostr-tools';

// Authenticated user context from NIP-98 or Service Token
export interface AuthContext {
  pubkey: string;        // Hex public key (or 'service' for service token)
  npub: string;          // Bech32 npub (or 'service' for service token)
  isAdmin: boolean;      // Is this an admin user
  isServiceToken?: boolean; // True if authenticated via SERVICE_TOKEN
}

// NIP-98 verification result
export interface Nip98Result {
  valid: boolean;
  pubkey?: string;
  error?: string;
}

// Generic API response
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// MCP Tool definitions
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: unknown, auth: AuthContext) => Promise<unknown>;
}

// ==================== APP REGISTRY TYPES ====================

// Registered app info (stored in superbased_apps table)
export interface AppInfo {
  app_pubkey: string;       // App's Nostr pubkey (hex)
  owner_pubkey: string;     // Who registered it (hex)
  name: string;
  schema_name: string;      // "app_<hash>"
  attestation_event: string; // Full signed registration event (JSON string)
  created_at: string;
  updated_at?: string;
}

// Result from app registration
export interface RegisterResult {
  app_npub: string;
  schema_name: string;
  created: boolean;
}

// ==================== RECORD SYNC TYPES (v3) ====================

// Input for syncing a single record
export interface SyncRecordInputV3 {
  record_id: string;
  encrypted_data: string;
  encrypted_from: string;
  collection?: string;
  delegate_payloads?: Record<string, string>;
  owner_pubkey?: string;
}

// Result from sync operation
export interface SyncResultV3 {
  synced: { record_id: string; version: number }[];
  created: number;
  updated: number;
  rejected: { record_id: string; reason: string }[];
}

// Internal sync outcome details for downstream side effects (e.g. push)
export interface SyncOutcomeRecord {
  record_id: string;
  version: number;
  owner_pubkey: string;
  collection: string;
}

// Record as returned from fetch (owner's view)
export interface RecordOutputV3 {
  record_id: string;
  version: number;
  collection: string;
  encrypted_data: string;
  encrypted_from: string;
  delegate_payloads?: Record<string, string>;
  created_at: string;
}

// Result from fetch
export interface FetchResultV3 {
  records: RecordOutputV3[];
}

// Record as returned to a delegate via /delegated
export interface DelegatedRecordOutputV3 {
  record_id: string;
  version: number;
  collection: string;
  owner_pubkey: string;
  encrypted_from: string;
  delegate_payload: string;
  created_at: string;
}

// Result from delegated fetch
export interface DelegatedFetchResultV3 {
  records: DelegatedRecordOutputV3[];
}

// Single version entry in history
export interface HistoryVersionV3 {
  version: number;
  record_state: string;
  encrypted_from: string;
  created_at: string;
  encrypted_data?: string;
  delegate_payloads?: Record<string, string>;
}

// Result from history endpoint
export interface HistoryResultV3 {
  record_id: string;
  owner_pubkey: string;
  versions: HistoryVersionV3[];
}

// ==================== TOKEN TYPES ====================

// Options for token generation
export interface TokenGenerationOptions {
  relay?: string;
  http?: string;
}

// Options for app-agnostic connection token generation
export interface ConnectionTokenOptions {
  relay?: string;
  http?: string;
  ttl_seconds?: number;
  scopes?: string[];
}

// ==================== USER TYPES ====================

// User info (stored in superbased_users table)
export interface UserInfo {
  id: string;
  user_pubkey: string;
  balance: number;
  whitelist: boolean;
  created_at: string;
  updated_at: string;
}

// Result from user access check
export interface UserAccessResult {
  allowed: boolean;
  reason?: string;
  user?: UserInfo;
}

// ==================== DELEGATION TYPES ====================

// Permission types for delegations
export type DelegationPermission = 'read' | 'write';

// Delegation record (stored in superbased_app_delegations table)
export interface AppDelegation {
  id: string;
  app_pubkey: string;       // App namespace (hex)
  owner_pubkey: string;     // Who granted the delegation (hex)
  delegate_pubkey: string;  // Who received the delegation (hex)
  permissions: DelegationPermission[];
  created_at: string;
  revoked_at?: string | null;
}

// Input for creating a delegation
export interface CreateDelegationInput {
  delegate_npub: string;
  permissions: DelegationPermission[];
}

// Result from delegation operations
export interface DelegationResult {
  delegation: AppDelegation;
  created: boolean;
}

// Result from write permission check
export interface WritePermissionResult {
  allowed: boolean;
  reason?: string;
}

// ==================== PUSH TYPES ====================

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushSubscriptionUpsertInput {
  subscription: PushSubscriptionInput;
  collections?: string[];
  device_id?: string;
}

export interface PushSubscriptionDeleteInput {
  endpoint: string;
}
