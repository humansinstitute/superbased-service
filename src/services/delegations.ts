import { nip19 } from 'nostr-tools';
import { FluxbaseClient } from '../fluxbase/client';
import { getConfig } from '../config';
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
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

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
    const existing = await client.query({
      table: DELEGATIONS_TABLE,
      filter: {
        app_pubkey: appPubkey,
        owner_pubkey: auth.pubkey,
        delegate_pubkey: delegatePubkey,
      },
      limit: 1,
    });

    if (existing.data?.length) {
      const existingDelegation = existing.data[0] as AppDelegation;

      // If revoked, un-revoke and update permissions
      // Otherwise just update permissions
      const updateResult = await client.update({
        table: DELEGATIONS_TABLE,
        filter: {
          id: existingDelegation.id,
        },
        data: {
          permissions: input.permissions,
          revoked_at: null,
        },
      });

      if (updateResult.error) {
        throw new Error(`Failed to update delegation: ${updateResult.error}`);
      }

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
    const insertResult = await client.insert({
      table: DELEGATIONS_TABLE,
      data: {
        app_pubkey: appPubkey,
        owner_pubkey: auth.pubkey,
        delegate_pubkey: delegatePubkey,
        permissions: input.permissions,
      },
    });

    if (insertResult.error) {
      throw new Error(`Failed to create delegation: ${insertResult.error}`);
    }

    const newDelegation = Array.isArray(insertResult.data)
      ? insertResult.data[0]
      : insertResult.data;

    return {
      delegation: newDelegation as AppDelegation,
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
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const result = await client.query({
      table: DELEGATIONS_TABLE,
      filter: {
        app_pubkey: appPubkey,
        owner_pubkey: auth.pubkey,
      },
      order: { column: 'created_at', ascending: false },
    });

    if (result.error) {
      throw new Error(`Failed to list delegations: ${result.error}`);
    }

    // Filter out revoked delegations
    const delegations = (result.data || []) as AppDelegation[];
    return delegations.filter(d => !d.revoked_at);
  }

  /**
   * Revoke a delegation (soft delete via revoked_at)
   */
  async revokeDelegation(
    appPubkey: string,
    auth: AuthContext,
    delegateNpub: string
  ): Promise<boolean> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

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

    const result = await client.update({
      table: DELEGATIONS_TABLE,
      filter: {
        app_pubkey: appPubkey,
        owner_pubkey: auth.pubkey,
        delegate_pubkey: delegatePubkey,
      },
      data: {
        revoked_at: new Date().toISOString(),
      },
    });

    return !result.error;
  }

  /**
   * Get a specific delegation
   */
  async getDelegation(
    appPubkey: string,
    ownerPubkey: string,
    delegatePubkey: string
  ): Promise<AppDelegation | null> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const result = await client.query({
      table: DELEGATIONS_TABLE,
      filter: {
        app_pubkey: appPubkey,
        owner_pubkey: ownerPubkey,
        delegate_pubkey: delegatePubkey,
      },
      limit: 1,
    });

    if (result.error || !result.data?.length) {
      return null;
    }

    const delegation = result.data[0] as AppDelegation;

    // Return null if revoked
    if (delegation.revoked_at) {
      return null;
    }

    return delegation;
  }

  /**
   * Get all delegations where user is the delegate for an app
   */
  async getDelegationsForDelegate(
    appPubkey: string,
    delegatePubkey: string
  ): Promise<AppDelegation[]> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const result = await client.query({
      table: DELEGATIONS_TABLE,
      filter: {
        app_pubkey: appPubkey,
        delegate_pubkey: delegatePubkey,
      },
      order: { column: 'created_at', ascending: false },
    });

    if (result.error) {
      return [];
    }

    // Filter out revoked delegations
    const delegations = (result.data || []) as AppDelegation[];
    return delegations.filter(d => !d.revoked_at);
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
