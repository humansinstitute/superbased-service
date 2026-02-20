import { FluxbaseClient } from '../fluxbase/client';
import { getConfig } from '../config';
import type { UserInfo, UserAccessResult } from '../types';

/**
 * Service for managing user registration and access control
 */
export class UsersService {
  /**
   * Get or create user record.
   * Auto-creates with balance=5000, whitelist=true on first access.
   */
  async getOrCreateUser(userPubkeyHex: string): Promise<UserInfo> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    // Try to find existing user
    const existing = await client.query({
      table: 'superbased_users',
      filter: { user_pubkey: userPubkeyHex },
      limit: 1,
    });

    if (existing.data?.length) {
      return existing.data[0] as UserInfo;
    }

    // Create new user with defaults
    const result = await client.insert({
      table: 'superbased_users',
      data: {
        user_pubkey: userPubkeyHex,
        balance: 5000,
        whitelist: true,
      },
    });

    if (result.error) {
      throw new Error(`Failed to create user: ${result.error}`);
    }

    // Fetch and return the created user
    const created = await client.query({
      table: 'superbased_users',
      filter: { user_pubkey: userPubkeyHex },
      limit: 1,
    });

    if (!created.data?.length) {
      throw new Error('User created but not found');
    }

    return created.data[0] as UserInfo;
  }

  /**
   * Check if user has access (balance > 0 OR whitelist = true)
   * Fails open if users table doesn't exist (backwards compatibility)
   */
  async checkUserAccess(userPubkeyHex: string): Promise<UserAccessResult> {
    try {
      const user = await this.getOrCreateUser(userPubkeyHex);

      if (user.whitelist) {
        return { allowed: true, user };
      }

      if (user.balance > 0) {
        return { allowed: true, user };
      }

      return {
        allowed: false,
        reason: 'User not whitelisted and has no balance. Please upgrade your account.',
        user,
      };
    } catch (err) {
      // Fail open if users table doesn't exist (backwards compatibility)
      const errorMsg = String(err);
      if (errorMsg.includes('not found') || errorMsg.includes('does not exist')) {
        console.warn('UsersService: users table not found, allowing access (backwards compatibility)');
        return { allowed: true };
      }
      throw err;
    }
  }

  /**
   * Get user by pubkey (returns null if not found)
   */
  async getUser(userPubkeyHex: string): Promise<UserInfo | null> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const result = await client.query({
      table: 'superbased_users',
      filter: { user_pubkey: userPubkeyHex },
      limit: 1,
    });

    if (!result.data?.length) {
      return null;
    }

    return result.data[0] as UserInfo;
  }

  /**
   * Update user balance
   */
  async updateBalance(userPubkeyHex: string, newBalance: number): Promise<void> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const result = await client.update({
      table: 'superbased_users',
      filter: { user_pubkey: userPubkeyHex },
      data: {
        balance: newBalance,
        updated_at: new Date().toISOString(),
      },
    });

    if (result.error) {
      throw new Error(`Failed to update balance: ${result.error}`);
    }
  }

  /**
   * Update user whitelist status
   */
  async setWhitelist(userPubkeyHex: string, whitelisted: boolean): Promise<void> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const result = await client.update({
      table: 'superbased_users',
      filter: { user_pubkey: userPubkeyHex },
      data: {
        whitelist: whitelisted,
        updated_at: new Date().toISOString(),
      },
    });

    if (result.error) {
      throw new Error(`Failed to update whitelist: ${result.error}`);
    }
  }
}

// Singleton instance
export const usersService = new UsersService();
