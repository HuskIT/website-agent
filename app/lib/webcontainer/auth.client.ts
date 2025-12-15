/**
 * Client-side authentication với CSRF protection và security best practices
 */

interface LoginResponse {
  success: boolean;
  user?: {
    id: string;
    email: string;
    name: string;
    avatar?: string;
  };
  token?: string;
  error?: string;
}

interface RegisterResponse {
  success: boolean;
  needsConfirmation?: boolean;
  message?: string;
  error?: string;
}

interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
}

class AuthClient {
  private _token: string | null = null;
  private _refreshToken: string | null = null;
  private _user: User | null = null;
  private _tokenExpiry: number | null = null;
  private _csrfToken: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this._loadFromStorage();
      this._initializeCsrfToken();

      // Check token validity on init
      if (this._token && this._isTokenExpired()) {
        this._refreshAccessToken().catch((error) => {
          console.error('Initial token refresh failed:', error);
          this._clearLocalStorage();
        });
      }
    }
  }

  /**
   * Initialize CSRF token
   */
  private async _initializeCsrfToken(): Promise<void> {
    try {
      const response = await fetch('/api/auth/csrf');
      const data = (await response.json()) as { token: string };

      if (data.token) {
        this._csrfToken = data.token;
      }
    } catch (error) {
      console.error('Failed to fetch CSRF token:', error);
    }
  }

  /**
   * Get CSRF token (fetch if needed)
   */
  private async _getCsrfToken(): Promise<string | null> {
    if (!this._csrfToken) {
      await this._initializeCsrfToken();
    }

    return this._csrfToken;
  }

  /**
   * Load data từ storage với error handling
   */
  private _loadFromStorage(): void {
    try {
      this._token = localStorage.getItem('auth_token');
      this._refreshToken = localStorage.getItem('refresh_token');

      const expiryStr = localStorage.getItem('token_expiry');

      if (expiryStr) {
        this._tokenExpiry = parseInt(expiryStr, 10);
      }

      const userStr = localStorage.getItem('auth_user');

      if (userStr) {
        this._user = JSON.parse(userStr);
      }
    } catch (e) {
      console.error('Failed to load auth data:', e);
      this._clearLocalStorage();
    }
  }

  /**
   * Clear all localStorage data
   */
  private _clearLocalStorage(): void {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('token_expiry');
      localStorage.removeItem('auth_user');
    }

    this._token = null;
    this._refreshToken = null;
    this._tokenExpiry = null;
    this._user = null;
  }

  /**
   * Check token expiry với buffer time
   */
  private _isTokenExpired(): boolean {
    if (!this._tokenExpiry) {
      return true;
    }

    // 5 minute buffer before expiry
    return Date.now() >= this._tokenExpiry - 5 * 60 * 1000;
  }

  /**
   * Refresh token với proper error handling
   */
  private async _refreshAccessToken(): Promise<boolean> {
    if (!this._refreshToken) {
      console.warn('No refresh token available');
      return false;
    }

    try {
      const { createClient } = await import('@supabase/supabase-js');

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

      if (!supabaseUrl || !supabaseKey) {
        console.error('Missing Supabase credentials');
        return false;
      }

      const supabase = createClient(supabaseUrl, supabaseKey);

      const { data, error } = await supabase.auth.refreshSession({
        refresh_token: this._refreshToken,
      });

      if (error || !data.session) {
        console.error('Token refresh failed:', error);
        this._clearLocalStorage();

        return false;
      }

      // Use actual expiry from Supabase session
      const expiresAt = data.session.expires_at
        ? data.session.expires_at * 1000 // Convert to milliseconds
        : Date.now() + 60 * 60 * 1000; // Fallback to 1 hour

      this._token = data.session.access_token;
      this._refreshToken = data.session.refresh_token;
      this._tokenExpiry = expiresAt;

      if (typeof window !== 'undefined') {
        localStorage.setItem('auth_token', data.session.access_token);
        localStorage.setItem('refresh_token', data.session.refresh_token);
        localStorage.setItem('token_expiry', expiresAt.toString());
      }

      return true;
    } catch (error) {
      console.error('Token refresh error:', error);
      this._clearLocalStorage();

      return false;
    }
  }

  /**
   * Get valid token (refresh if needed)
   */
  private async _getValidToken(): Promise<string | null> {
    if (!this._token) {
      return null;
    }

    if (this._isTokenExpired()) {
      const refreshed = await this._refreshAccessToken();

      if (!refreshed) {
        return null;
      }
    }

    return this._token;
  }

  /**
   * Login với CSRF protection
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    try {
      const csrfToken = await this._getCsrfToken();

      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
        },
        body: JSON.stringify({ email, password }),
      });

      const data = (await response.json()) as { token: string; user: User; error?: string };

      if (!response.ok) {
        return {
          success: false,
          error: data.error || 'Đăng nhập thất bại',
        };
      }

      const { token, user } = data;

      if (token && user) {
        this._token = token;
        this._user = user;

        // Try to get actual expiry, fallback to 1 hour
        const expiryTime = Date.now() + 60 * 60 * 1000;
        this._tokenExpiry = expiryTime;

        if (typeof window !== 'undefined') {
          localStorage.setItem('auth_token', token);
          localStorage.setItem('auth_user', JSON.stringify(user));
          localStorage.setItem('token_expiry', expiryTime.toString());
        }
      }

      return { success: true, token, user };
    } catch (error) {
      console.error('Login error:', error);
      return {
        success: false,
        error: 'Không thể kết nối đến server',
      };
    }
  }

  /**
   * Register với CSRF protection
   */
  async register(email: string, password: string, name?: string): Promise<RegisterResponse> {
    try {
      const csrfToken = await this._getCsrfToken();

      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
        },
        body: JSON.stringify({ email, password, name }),
      });

      const data = (await response.json()) as { needsConfirmation?: boolean; message?: string; error?: string };

      if (!response.ok) {
        return {
          success: false,
          error: data.error || 'Đăng ký thất bại',
        };
      }

      return {
        success: true,
        needsConfirmation: data.needsConfirmation,
        message: data.message,
      };
    } catch (error) {
      console.error('Register error:', error);
      return {
        success: false,
        error: 'Không thể kết nối đến server',
      };
    }
  }

  /**
   * Login with Google OAuth
   */
  async loginWithGoogle(): Promise<void> {
    try {
      const response = await fetch('/api/auth/google');
      const data = (await response.json()) as { url: string };

      if (!response.ok || !data.url) {
        throw new Error('Failed to get Google OAuth URL');
      }

      window.location.href = data.url;
    } catch (error) {
      console.error('Google login error:', error);
      throw error;
    }
  }

  /**
   * Logout với CSRF protection
   */
  async logout(): Promise<boolean> {
    try {
      const token = await this._getValidToken();
      const csrfToken = await this._getCsrfToken();

      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
          },
        });
      }

      this._clearLocalStorage();

      return true;
    } catch (error) {
      console.error('Logout error:', error);
      this._clearLocalStorage();

      return false;
    }
  }

  /**
   * Check authentication status
   */
  async checkAuth(): Promise<boolean> {
    const token = await this._getValidToken();

    if (!token) {
      return false;
    }

    try {
      const response = await fetch('/api/auth/session', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        this._clearLocalStorage();
        return false;
      }

      const data = (await response.json()) as { authenticated: boolean; user: User | null };

      if (data.user && JSON.stringify(data.user) !== JSON.stringify(this._user)) {
        this._user = data.user;

        if (typeof window !== 'undefined') {
          localStorage.setItem('auth_user', JSON.stringify(data.user));
        }
      }

      return true;
    } catch (error) {
      console.error('Auth check error:', error);
      return false;
    }
  }

  /**
   * Get current user
   */
  getUser(): User | null {
    return this._user;
  }

  /**
   * Get valid token
   */
  async getToken(): Promise<string | null> {
    return this._getValidToken();
  }

  /**
   * Get token sync (no refresh)
   */
  getTokenSync(): string | null {
    return this._token;
  }

  /**
   * Check if authenticated
   */
  isAuthenticated(): boolean {
    return !!this._token && !!this._user;
  }

  /**
   * Update user data
   */
  updateUser(user: User): void {
    this._user = user;

    if (typeof window !== 'undefined') {
      localStorage.setItem('auth_user', JSON.stringify(user));
    }
  }
}

export const authClient = new AuthClient();
