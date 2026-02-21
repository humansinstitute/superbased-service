import { getDb } from '../db/postgres';
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
    const sql = getDb();

    // Try to find existing user
    const existing = await sql`
      SELECT * FROM superbased_users
      WHERE user_pubkey = ${userPubkeyHex}
      LIMIT 1
    `;

    if (existing.length > 0) {
      return existing[0] as unknown as UserInfo;
    }

    // Create new user with defaults and return it
    const inserted = await sql`
      INSERT INTO superbased_users (user_pubkey, balance, whitelist)
      VALUES (${userPubkeyHex}, 5000, true)
      RETURNING *
    `;

    return inserted[0] as unknown as UserInfo;
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
    const sql = getDb();

    const rows = await sql`
      SELECT * FROM superbased_users
      WHERE user_pubkey = ${userPubkeyHex}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return null;
    }

    return rows[0] as unknown as UserInfo;
  }

  /**
   * Update user balance
   */
  async updateBalance(userPubkeyHex: string, newBalance: number): Promise<void> {
    const sql = getDb();

    const result = await sql`
      UPDATE superbased_users
      SET balance = ${newBalance},
          updated_at = now()
      WHERE user_pubkey = ${userPubkeyHex}
    `;

    if (result.count === 0) {
      throw new Error('Failed to update balance: user not found');
    }
  }

  /**
   * Update user whitelist status
   */
  async setWhitelist(userPubkeyHex: string, whitelisted: boolean): Promise<void> {
    const sql = getDb();

    const result = await sql`
      UPDATE superbased_users
      SET whitelist = ${whitelisted},
          updated_at = now()
      WHERE user_pubkey = ${userPubkeyHex}
    `;

    if (result.count === 0) {
      throw new Error('Failed to update whitelist: user not found');
    }
  }
}

// Singleton instance
export const usersService = new UsersService();
