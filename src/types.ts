import type { Event } from 'nostr-tools';

// Authenticated user context from NIP-98 or Service Token
export interface AuthContext {
  pubkey: string;        // Hex public key (or 'service' for service token)
  npub: string;          // Bech32 npub (or 'service' for service token)
  isAdmin: boolean;      // Is this an admin user
  isServiceToken?: boolean; // True if authenticated via SERVICE_TOKEN
  fluxbaseUserId?: string;  // Mapped Fluxbase user ID
  fluxbaseJwt?: string;     // JWT for Fluxbase requests
}

// NIP-98 verification result
export interface Nip98Result {
  valid: boolean;
  pubkey?: string;
  error?: string;
}

// Fluxbase user mapping
export interface UserMapping {
  npub: string;
  pubkeyHex: string;
  fluxbaseUserId: string;
  createdAt: Date;
}

// Generic API response
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// Database operation types
export interface DbQueryParams {
  table: string;
  select?: string;
  filter?: Record<string, unknown>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
  offset?: number;
}

export interface DbInsertParams {
  table: string;
  data: Record<string, unknown> | Record<string, unknown>[];
}

export interface DbUpdateParams {
  table: string;
  filter: Record<string, unknown>;
  data: Record<string, unknown>;
}

export interface DbDeleteParams {
  table: string;
  filter: Record<string, unknown>;
}

// Storage operation types
export interface StorageUploadParams {
  bucket: string;
  path: string;
  content: string | Uint8Array;
  contentType?: string;
}

export interface StorageDownloadParams {
  bucket: string;
  path: string;
}

export interface StorageListParams {
  bucket: string;
  prefix?: string;
  limit?: number;
  offset?: number;
}

export interface StorageDeleteParams {
  bucket: string;
  path: string;
}

// Function invocation
export interface FunctionInvokeParams {
  name: string;
  payload?: unknown;
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

// ==================== RECORD SYNC TYPES ====================

// Delegate encryption entry - one per delegate who can read this record
export interface DelegateEncryption {
  delegate_pubkey: string;    // Delegate's pubkey (hex or npub)
  encrypted_blob: string;     // NIP-44 encrypted payload for this delegate
}

// Input for syncing a single record
export interface SyncRecordInput {
  record_id: string;          // Client-provided ID
  collection?: string;        // Optional collection name (default: 'default')
  encrypted_data: string;     // NIP-44 encrypted payload (owner's copy)
  delegates?: DelegateEncryption[]; // Encrypted copies for each delegate
  metadata?: Record<string, unknown>; // Can include assigned_to for per-record delegation
  owner_pubkey?: string;      // Actual owner pubkey (hex) — used when a delegate creates on behalf of an owner
}

// Result from sync operation
export interface SyncResult {
  synced_count: number;
  created: number;
  updated: number;
  denied?: number; // Records denied due to permission check
}

// Record as returned from fetch
export interface RecordOutput {
  record_id: string;
  collection: string;
  encrypted_data: string;
  delegates?: DelegateEncryption[]; // Encrypted copies for delegates
  metadata: Record<string, unknown>;
  updated_at: string;
  owner_pubkey?: string; // Included when fetching as delegate
}

// Result from fetch operation
export interface FetchResult {
  records: RecordOutput[];
}

// ==================== TOKEN TYPES ====================

// Options for token generation
export interface TokenGenerationOptions {
  relay?: string;
  http?: string;
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

// ==================== DER DELEGATED FETCH TYPES ====================

// Record as returned to a delegate via /delegated endpoint
export interface DelegatedRecordOutput {
  record_id: string;
  collection: string;
  owner_pubkey: string;
  access: 'read' | 'write';
  metadata: Record<string, unknown>;
  delegate_payload: string;       // Only this delegate's NIP-44 blob
  updated_at: string;
}

// Result from delegated fetch
export interface DelegatedFetchResult {
  records: DelegatedRecordOutput[];
  cursor: string | null;
}

// Params for delegated fetch
export interface DelegatedFetchParams {
  since?: string;
  collection?: string;
  limit?: number;
  cursor?: string;
  /** Hex pubkey of the record owner — scopes results to a single user */
  ownerPubkey?: string;
}
