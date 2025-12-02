/**
 * This client-only module that contains everything related to auth and is used
 * to avoid importing `@webcontainer/api` in the server bundle.
 */

// Client-side authentication helper

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

  constructor() {
    // Load auth data from localStorage on init
    if (typeof window !== 'undefined') {
      this._token = localStorage.getItem('auth_token');
      this._refreshToken = localStorage.getItem('refresh_token');

      const expiryStr = localStorage.getItem('token_expiry');

      if (expiryStr) {
        this._tokenExpiry = parseInt(expiryStr);
      }

      const userStr = localStorage.getItem('auth_user');

      if (userStr) {
        try {
          this._user = JSON.parse(userStr);
        } catch (e) {
          console.error('Failed to parse user data:', e);

          // Clear corrupted data
          this._clearLocalStorage();
        }
      }

      // Check if token is expired and try to refresh
      if (this._token && this._isTokenExpired()) {
        this._refreshAccessToken().catch((error) => {
          console.error('Initial token refresh failed:', error);
          this._clearLocalStorage();
        });
      }
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
   * Check if token is expired
   */
  private _isTokenExpired(): boolean {
    if (!this._tokenExpiry) {
      return true;
    }

    // Add 5 minute buffer before actual expiry
    return Date.now() >= this._tokenExpiry - 5 * 60 * 1000;
  }

  /**
   * Refresh access token using refresh token
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

      // Update tokens
      this._token = data.session.access_token;
      this._refreshToken = data.session.refresh_token;

      const newExpiryTime = Date.now() + 60 * 60 * 1000; // 1 hour
      this._tokenExpiry = newExpiryTime;

      if (typeof window !== 'undefined') {
        localStorage.setItem('auth_token', data.session.access_token);
        localStorage.setItem('refresh_token', data.session.refresh_token);
        localStorage.setItem('token_expiry', newExpiryTime.toString());
      }

      console.log('Token refreshed successfully');

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
   * Login with email and password
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (typeof data !== 'object' || data === null) {
        return {
          success: false,
          error: 'Invalid response from server',
        };
      }

      const token = 'token' in data && typeof data.token === 'string' ? data.token : undefined;
      const user = 'user' in data && typeof data.user === 'object' ? (data.user as User) : undefined;
      const error = 'error' in data && typeof data.error === 'string' ? data.error : undefined;

      if (!response.ok) {
        return { success: false, error: error || 'Đăng nhập thất bại' };
      }

      if (token && user) {
        this._token = token;
        this._user = user;

        // Set expiry time (1 hour from now)
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
   * Register new account
   */
  async register(email: string, password: string, name?: string): Promise<RegisterResponse> {
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password, name }),
      });

      const data = (await response.json()) as {
        success: boolean;
        needsConfirmation?: boolean;
        message?: string;
        error?: string;
      };

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

      // Redirect to Google OAuth
      window.location.href = data.url;
    } catch (error) {
      console.error('Google login error:', error);
      throw error;
    }
  }

  /**
   * Logout
   */
  async logout(): Promise<boolean> {
    try {
      const token = await this._getValidToken();

      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      }

      // Clear local data
      this._clearLocalStorage();

      return true;
    } catch (error) {
      console.error('Logout error:', error);

      // Still clear local data even if API call fails
      this._clearLocalStorage();

      return false;
    }
  }

  /**
   * Check if user is authenticated
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
        // Token invalid, clear local data
        this._clearLocalStorage();
        return false;
      }

      const data = (await response.json()) as {
        authenticated: boolean;
        user: User;
      };

      // Update user data if changed
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
   * Get current token (will refresh if expired)
   */
  async getToken(): Promise<string | null> {
    return this._getValidToken();
  }

  /**
   * Get current token (synchronous, no refresh)
   */
  getTokenSync(): string | null {
    return this._token;
  }

  /**
   * Check if user is logged in (from local data)
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

// Export singleton instance
export const authClient = new AuthClient();
