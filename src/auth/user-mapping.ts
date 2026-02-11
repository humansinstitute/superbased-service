import { nip19 } from 'nostr-tools';
import { getConfig } from '../config';
import type { AuthContext, UserMapping } from '../types';

// In-memory cache of user mappings
// In production, this could be persisted to a file or database
const userMappings = new Map<string, UserMapping>();

/**
 * Get or create a Fluxbase user for the given npub
 */
export async function getOrCreateFluxbaseUser(auth: AuthContext): Promise<AuthContext> {
  const config = getConfig();

  // Check cache first
  const cached = userMappings.get(auth.pubkey);
  if (cached) {
    return {
      ...auth,
      fluxbaseUserId: cached.fluxbaseUserId,
    };
  }

  // Try to find existing user by metadata
  const existingUser = await findUserByNpub(auth.npub);
  if (existingUser) {
    // Cache and return
    const mapping: UserMapping = {
      npub: auth.npub,
      pubkeyHex: auth.pubkey,
      fluxbaseUserId: existingUser.id,
      createdAt: new Date(),
    };
    userMappings.set(auth.pubkey, mapping);

    return {
      ...auth,
      fluxbaseUserId: existingUser.id,
    };
  }

  // Create new user
  const newUser = await createFluxbaseUser(auth);
  if (newUser) {
    const mapping: UserMapping = {
      npub: auth.npub,
      pubkeyHex: auth.pubkey,
      fluxbaseUserId: newUser.id,
      createdAt: new Date(),
    };
    userMappings.set(auth.pubkey, mapping);

    return {
      ...auth,
      fluxbaseUserId: newUser.id,
    };
  }

  // Failed to create user - return auth without user ID
  console.error(`Failed to create Fluxbase user for ${auth.npub}`);
  return auth;
}

/**
 * Find a Fluxbase user by their nostr npub
 */
async function findUserByNpub(npub: string): Promise<{ id: string } | null> {
  const config = getConfig();

  try {
    // Query Fluxbase for user with matching nostr_pubkey in metadata
    // This requires the service key for admin access
    if (!config.fluxbaseServiceKey) {
      console.warn('No FLUXBASE_SERVICE_KEY configured, cannot lookup users');
      return null;
    }

    const response = await fetch(`${config.fluxbaseUrl}/api/v1/auth/admin/users`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.fluxbaseServiceKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      // Users endpoint might not exist or be accessible
      // This is okay - we'll create users on demand
      return null;
    }

    const users = await response.json();

    // Find user with matching npub in user_metadata
    const found = users.find((u: any) =>
      u.user_metadata?.nostr_npub === npub ||
      u.user_metadata?.nostr_pubkey === npub
    );

    return found ? { id: found.id } : null;
  } catch (error) {
    console.error('Error finding user by npub:', error);
    return null;
  }
}

/**
 * Create a new Fluxbase user for the given auth context
 */
async function createFluxbaseUser(auth: AuthContext): Promise<{ id: string } | null> {
  const config = getConfig();

  try {
    // Use Fluxbase signup endpoint or admin API
    // Generate a unique email from the full npub
    const email = `${auth.npub}@nostrmail.com`;

    // Generate a random password (user will never use it - they auth via NIP-98)
    const password = crypto.randomUUID();

    const response = await fetch(`${config.fluxbaseUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.fluxbaseAnonKey && { 'apikey': config.fluxbaseAnonKey }),
      },
      body: JSON.stringify({
        email,
        password,
        user_metadata: {
          nostr_npub: auth.npub,
          nostr_pubkey: auth.pubkey,
          created_via: 'flux_adaptor',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Check if user already exists - try to find them
      if (errorText.includes('already exists')) {
        console.log(`User already exists for ${auth.npub}, attempting login...`);
        return await loginExistingUser(email, auth);
      }

      console.error('Failed to create Fluxbase user:', errorText);
      return null;
    }

    const result = await response.json();
    console.log(`Created Fluxbase user for ${auth.npub}: ${result.user?.id}`);

    return result.user ? { id: result.user.id } : null;
  } catch (error) {
    console.error('Error creating Fluxbase user:', error);
    return null;
  }
}

/**
 * Try to get user ID for an existing user by email
 */
async function loginExistingUser(email: string, auth: AuthContext): Promise<{ id: string } | null> {
  const config = getConfig();

  // Try to find the user via admin API
  if (config.fluxbaseServiceKey) {
    try {
      const response = await fetch(`${config.fluxbaseUrl}/api/v1/auth/admin/users`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.fluxbaseServiceKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const users = await response.json();
        const found = users.find((u: any) => u.email === email);
        if (found) {
          console.log(`Found existing user for ${auth.npub}: ${found.id}`);
          return { id: found.id };
        }
      }
    } catch (error) {
      console.error('Error looking up existing user:', error);
    }
  }

  // If we can't find the user, generate a deterministic ID based on pubkey
  // This allows the system to continue working even without user lookup
  const deterministicId = `nostr:${auth.pubkey}`;
  console.log(`Using deterministic ID for ${auth.npub}: ${deterministicId}`);
  return { id: deterministicId };
}

/**
 * Generate a Fluxbase JWT for the given user
 * This requires admin/service access to generate JWTs on behalf of users
 */
export async function generateFluxbaseJwt(auth: AuthContext): Promise<string | null> {
  const config = getConfig();

  // If no service key, we can't generate JWTs
  if (!config.fluxbaseServiceKey) {
    console.warn('No FLUXBASE_SERVICE_KEY configured, using anon key');
    return config.fluxbaseAnonKey || null;
  }

  // For now, use the service key directly
  // TODO: Implement per-user JWT generation via Fluxbase admin API
  // This would involve calling an endpoint like /api/v1/auth/admin/generate-token
  return config.fluxbaseServiceKey;
}

/**
 * Clear the user mapping cache
 */
export function clearUserMappingCache(): void {
  userMappings.clear();
}

/**
 * Get cache stats
 */
export function getUserMappingStats(): { size: number; entries: string[] } {
  return {
    size: userMappings.size,
    entries: Array.from(userMappings.keys()),
  };
}
