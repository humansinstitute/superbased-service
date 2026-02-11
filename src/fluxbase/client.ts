import { getConfig } from '../config';
import type { AuthContext, DbQueryParams, DbInsertParams, DbUpdateParams, DbDeleteParams } from '../types';

/**
 * Fluxbase client for making authenticated requests
 */
export class FluxbaseClient {
  private baseUrl: string;
  private authToken: string | null;

  constructor(authToken?: string) {
    const config = getConfig();
    this.baseUrl = config.fluxbaseUrl;
    this.authToken = authToken ?? config.fluxbaseAnonKey ?? null;
  }

  /**
   * Create a client for a specific auth context
   */
  static forAuth(auth: AuthContext): FluxbaseClient {
    const token = auth.fluxbaseJwt ?? getConfig().fluxbaseServiceKey ?? getConfig().fluxbaseAnonKey;
    return new FluxbaseClient(token ?? undefined);
  }

  /**
   * Make an authenticated request to Fluxbase
   */
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<{ data: T | null; error: string | null }> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    };

    if (this.authToken) {
      // Detect token type: JWT starts with 'eyJ', service keys with 'sk_'
      if (this.authToken.startsWith('eyJ')) {
        // JWT token
        headers['Authorization'] = `Bearer ${this.authToken}`;
      } else {
        // Service key - use X-Service-Key header
        headers['X-Service-Key'] = this.authToken;
      }
      // Also set apikey for compatibility
      headers['apikey'] = this.authToken;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorJson.message || errorText;
        } catch {
          errorMessage = errorText;
        }
        return { data: null, error: `${response.status}: ${errorMessage}` };
      }

      // Handle empty responses
      const text = await response.text();
      if (!text) {
        return { data: null, error: null };
      }

      const data = JSON.parse(text) as T;
      return { data, error: null };
    } catch (error) {
      return { data: null, error: String(error) };
    }
  }

  // ==================== Database Operations ====================

  /**
   * Query records from a table
   */
  async query(params: DbQueryParams): Promise<{ data: unknown[] | null; error: string | null }> {
    const { table, select, filter, order, limit, offset } = params;

    // Build query string
    const queryParams = new URLSearchParams();

    if (select) {
      queryParams.set('select', select);
    }

    // Convert filter to PostgREST format
    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (typeof value === 'object' && value !== null) {
          // Handle operators like { eq: 'value' }, { gt: 5 }, etc.
          for (const [op, val] of Object.entries(value as Record<string, unknown>)) {
            queryParams.set(key, `${op}.${val}`);
          }
        } else {
          // Simple equality
          queryParams.set(key, `eq.${value}`);
        }
      }
    }

    if (order) {
      queryParams.set('order', `${order.column}.${order.ascending ? 'asc' : 'desc'}`);
    }

    if (limit !== undefined) {
      queryParams.set('limit', String(limit));
    }

    if (offset !== undefined) {
      queryParams.set('offset', String(offset));
    }

    const queryString = queryParams.toString();
    const path = `/api/v1/tables/${table}${queryString ? `?${queryString}` : ''}`;

    return this.request<unknown[]>(path, { method: 'GET' });
  }

  /**
   * Insert records into a table
   */
  async insert(params: DbInsertParams): Promise<{ data: unknown | null; error: string | null }> {
    const { table, data } = params;

    return this.request(`/api/v1/tables/${table}`, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'Prefer': 'return=representation',
      },
    });
  }

  /**
   * Update records in a table
   */
  async update(params: DbUpdateParams): Promise<{ data: unknown | null; error: string | null }> {
    const { table, filter, data } = params;

    // Build filter query string
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (typeof value === 'object' && value !== null) {
        for (const [op, val] of Object.entries(value as Record<string, unknown>)) {
          queryParams.set(key, `${op}.${val}`);
        }
      } else {
        queryParams.set(key, `eq.${value}`);
      }
    }

    const queryString = queryParams.toString();
    const path = `/api/v1/tables/${table}${queryString ? `?${queryString}` : ''}`;

    return this.request(path, {
      method: 'PATCH',
      body: JSON.stringify(data),
      headers: {
        'Prefer': 'return=representation',
      },
    });
  }

  /**
   * Delete records from a table
   */
  async delete(params: DbDeleteParams): Promise<{ data: unknown | null; error: string | null }> {
    const { table, filter } = params;

    // Build filter query string
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (typeof value === 'object' && value !== null) {
        for (const [op, val] of Object.entries(value as Record<string, unknown>)) {
          queryParams.set(key, `${op}.${val}`);
        }
      } else {
        queryParams.set(key, `eq.${value}`);
      }
    }

    const queryString = queryParams.toString();
    const path = `/api/v1/tables/${table}${queryString ? `?${queryString}` : ''}`;

    return this.request(path, { method: 'DELETE' });
  }

  // ==================== Storage Operations ====================

  /**
   * Upload a file to storage
   */
  async uploadFile(
    bucket: string,
    path: string,
    content: Uint8Array | string,
    contentType: string = 'application/octet-stream'
  ): Promise<{ data: unknown | null; error: string | null }> {
    const url = `${this.baseUrl}/api/v1/storage/object/${bucket}/${path}`;

    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          ...(this.authToken && {
            'Authorization': `Bearer ${this.authToken}`,
            'apikey': this.authToken,
          }),
        },
        body,
      });

      if (!response.ok) {
        const error = await response.text();
        return { data: null, error: `${response.status}: ${error}` };
      }

      const data = await response.json();
      return { data, error: null };
    } catch (error) {
      return { data: null, error: String(error) };
    }
  }

  /**
   * Download a file from storage
   */
  async downloadFile(
    bucket: string,
    path: string
  ): Promise<{ data: Uint8Array | null; contentType: string | null; error: string | null }> {
    const url = `${this.baseUrl}/api/v1/storage/object/${bucket}/${path}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...(this.authToken && {
            'Authorization': `Bearer ${this.authToken}`,
            'apikey': this.authToken,
          }),
        },
      });

      if (!response.ok) {
        const error = await response.text();
        return { data: null, contentType: null, error: `${response.status}: ${error}` };
      }

      const contentType = response.headers.get('Content-Type');
      const data = new Uint8Array(await response.arrayBuffer());
      return { data, contentType, error: null };
    } catch (error) {
      return { data: null, contentType: null, error: String(error) };
    }
  }

  /**
   * List files in a storage bucket
   */
  async listFiles(
    bucket: string,
    prefix?: string,
    limit?: number,
    offset?: number
  ): Promise<{ data: unknown[] | null; error: string | null }> {
    const queryParams = new URLSearchParams();
    if (prefix) queryParams.set('prefix', prefix);
    if (limit) queryParams.set('limit', String(limit));
    if (offset) queryParams.set('offset', String(offset));

    const queryString = queryParams.toString();
    const path = `/api/v1/storage/object/list/${bucket}${queryString ? `?${queryString}` : ''}`;

    return this.request<unknown[]>(path, { method: 'POST', body: JSON.stringify({}) });
  }

  /**
   * Delete a file from storage
   */
  async deleteFile(bucket: string, path: string): Promise<{ error: string | null }> {
    const url = `${this.baseUrl}/api/v1/storage/object/${bucket}/${path}`;

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          ...(this.authToken && {
            'Authorization': `Bearer ${this.authToken}`,
            'apikey': this.authToken,
          }),
        },
      });

      if (!response.ok) {
        const error = await response.text();
        return { error: `${response.status}: ${error}` };
      }

      return { error: null };
    } catch (error) {
      return { error: String(error) };
    }
  }

  // ==================== Edge Functions ====================

  /**
   * Invoke an edge function
   */
  async invokeFunction(
    name: string,
    payload?: unknown
  ): Promise<{ data: unknown | null; error: string | null }> {
    return this.request(`/api/v1/functions/${name}`, {
      method: 'POST',
      body: payload ? JSON.stringify(payload) : undefined,
    });
  }

  // ==================== Health Check ====================

  /**
   * Check Fluxbase health
   */
  async health(): Promise<{ healthy: boolean; details?: unknown }> {
    const result = await this.request<{ status: string }>('/health');
    return {
      healthy: result.data?.status === 'ok',
      details: result.data,
    };
  }
}
