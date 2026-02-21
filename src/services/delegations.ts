import { nip19 } from 'nostr-tools';
import { getDb } from '../db/postgres';
import type {
  AuthContext,
  AppDelegation,
  CreateDelegationInput,
  DelegationResult,
  DelegationPermission,
  WritePermissionResult,
} from '../types';

const DELEGATIONS_TABLE = 'superbased_app_delegations';

/**
 * Service for managing app-level and per-record delegations
 */
export class DelegationsService {
  /**
   * Grant delegation to a pubkey
   */
  async grantDelegation(
    appPubkey: string,
    auth: AuthContext,
    input: CreateDelegationInput
  ): Promise<DelegationResult> {
    const sql = getDb();

    // Decode delegate npub to hex
    let delegatePubkey: string;
    try {
      const decoded = nip19.decode(input.delegate_npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid delegate_npub: must be an npub');
      }
      delegatePubkey = decoded.data as string;
    } catch (err) {
      throw new Error(`Invalid delegate_npub: ${err}`);
    }

    // Validate permissions
    const validPermissions: DelegationPermission[] = ['read', 'write'];
    for (const perm of input.permissions) {
      if (!validPermissions.includes(perm)) {
        throw new Error(`Invalid permission: ${perm}`);
      }
    }

    // Check if delegation already exists
    const existing = await sql`
      SELECT * FROM ${sql(DELEGATIONS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${auth.pubkey}
        AND delegate_pubkey = ${delegatePubkey}
      LIMIT 1
    `;

    if (existing.length > 0) {
      const existingDelegation = existing[0] as unknown as AppDelegation;

      // Update permissions (and un-revoke if revoked)
      await sql`
        UPDATE ${sql(DELEGATIONS_TABLE)}
        SET permissions = ${sql.array(input.permissions)},
            revoked_at = NULL
        WHERE id = ${existingDelegation.id}
      `;

      return {
        delegation: {
          ...existingDelegation,
          permissions: input.permissions,
          revoked_at: null,
        },
        created: false,
      };
    }

    // Create new delegation
    const inserted = await sql`
      INSERT INTO ${sql(DELEGATIONS_TABLE)}
        (app_pubkey, owner_pubkey, delegate_pubkey, permissions)
      VALUES
        (${appPubkey}, ${auth.pubkey}, ${delegatePubkey}, ${sql.array(input.permissions)})
      RETURNING *
    `;

    return {
      delegation: inserted[0] as unknown as AppDelegation,
      created: true,
    };
  }

  /**
   * List delegations granted by the authenticated user for an app
   */
  async listDelegations(
    appPubkey: string,
    auth: AuthContext
  ): Promise<AppDelegation[]> {
    const sql = getDb();

    const rows = await sql`
      SELECT * FROM ${sql(DELEGATIONS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${auth.pubkey}
        AND revoked_at IS NULL
      ORDER BY created_at DESC
    `;

    return rows as unknown as AppDelegation[];
  }

  /**
   * Revoke a delegation (soft delete via revoked_at)
   */
  async revokeDelegation(
    appPubkey: string,
    auth: AuthContext,
    delegateNpub: string
  ): Promise<boolean> {
    const sql = getDb();

    // Decode delegate npub to hex
    let delegatePubkey: string;
    try {
      const decoded = nip19.decode(delegateNpub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid delegate_npub: must be an npub');
      }
      delegatePubkey = decoded.data as string;
    } catch (err) {
      throw new Error(`Invalid delegate_npub: ${err}`);
    }

    const result = await sql`
      UPDATE ${sql(DELEGATIONS_TABLE)}
      SET revoked_at = now()
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${auth.pubkey}
        AND delegate_pubkey = ${delegatePubkey}
        AND revoked_at IS NULL
    `;

    return result.count > 0;
  }

  /**
   * Get a specific delegation
   */
  async getDelegation(
    appPubkey: string,
    ownerPubkey: string,
    delegatePubkey: string
  ): Promise<AppDelegation | null> {
    const sql = getDb();

    const rows = await sql`
      SELECT * FROM ${sql(DELEGATIONS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${ownerPubkey}
        AND delegate_pubkey = ${delegatePubkey}
        AND revoked_at IS NULL
      LIMIT 1
    `;

    if (rows.length === 0) {
      return null;
    }

    return rows[0] as unknown as AppDelegation;
  }

  /**
   * Get all delegations where user is the delegate for an app
   */
  async getDelegationsForDelegate(
    appPubkey: string,
    delegatePubkey: string
  ): Promise<AppDelegation[]> {
    const sql = getDb();

    const rows = await sql`
      SELECT * FROM ${sql(DELEGATIONS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND delegate_pubkey = ${delegatePubkey}
        AND revoked_at IS NULL
      ORDER BY created_at DESC
    `;

    return rows as unknown as AppDelegation[];
  }

  /**
   * Check if a signer has write permission for a record
   *
   * Write Validation Order:
   * 1. Signer is record owner → allow
   * 2. Signer has app-level "write" delegation from owner → allow
   * 3. Signer matches metadata.assigned_to → allow
   * 4. Signer's pubkey is in metadata.write_delegates (DER v1) → allow
   * 5. Else → deny
   */
  async checkWritePermission(
    appPubkey: string,
    signerPubkey: string,
    recordOwnerPubkey: string,
    assignedTo?: string,
    writeDelegates?: string[]
  ): Promise<WritePermissionResult> {
    // 1. Signer is record owner
    if (signerPubkey === recordOwnerPubkey) {
      return { allowed: true, reason: 'owner' };
    }

    // 2. Check for app-level write delegation
    const delegation = await this.getDelegation(
      appPubkey,
      recordOwnerPubkey,
      signerPubkey
    );

    if (delegation && delegation.permissions.includes('write')) {
      return { allowed: true, reason: 'app_delegation' };
    }

    // 3. Check if signer matches assigned_to
    if (assignedTo && assignedTo === signerPubkey) {
      return { allowed: true, reason: 'assigned_to' };
    }

    // 4. Check DER v1 per-record write_delegates
    if (writeDelegates && writeDelegates.includes(signerPubkey)) {
      return { allowed: true, reason: 'write_delegate' };
    }

    // 5. Deny
    return { allowed: false, reason: 'no_permission' };
  }

  /**
   * Check if a delegate has read permission for records from an owner
   */
  async checkReadPermission(
    appPubkey: string,
    delegatePubkey: string,
    ownerPubkey: string
  ): Promise<boolean> {
    const delegation = await this.getDelegation(
      appPubkey,
      ownerPubkey,
      delegatePubkey
    );

    return delegation !== null && delegation.permissions.includes('read');
  }

  /**
   * Get all owner pubkeys that have granted read access to a delegate
   */
  async getOwnersWithReadAccess(
    appPubkey: string,
    delegatePubkey: string
  ): Promise<string[]> {
    const delegations = await this.getDelegationsForDelegate(appPubkey, delegatePubkey);

    return delegations
      .filter(d => d.permissions.includes('read'))
      .map(d => d.owner_pubkey);
  }
}

// Singleton instance
export const delegationsService = new DelegationsService();
