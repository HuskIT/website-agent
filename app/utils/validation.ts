/**
 * ✅ Validation utilities cho auth endpoints
 */

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // RFC 5322 compliant email regex (simplified)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return emailRegex.test(email.trim()) && email.length <= 254;
}

/**
 * Validate password strength
 */
export function isStrongPassword(password: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!password || typeof password !== 'string') {
    return { valid: false, errors: ['Mật khẩu không hợp lệ'] };
  }

  if (password.length < 8) {
    errors.push('Mật khẩu phải có ít nhất 8 ký tự');
  }

  if (password.length > 128) {
    errors.push('Mật khẩu quá dài (tối đa 128 ký tự)');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Mật khẩu phải có ít nhất 1 chữ thường');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Mật khẩu phải có ít nhất 1 chữ hoa');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Mật khẩu phải có ít nhất 1 số');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Sanitize user input
 */
export function sanitizeInput(input: string, maxLength: number = 255): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  return input.trim().substring(0, maxLength).replace(/[<>]/g, ''); // Remove potential XSS characters
}

/**
 * Validate name format
 */
export function isValidName(name: string): boolean {
  if (!name || typeof name !== 'string') {
    return false;
  }

  const trimmed = name.trim();

  // Name should be 1-100 characters, alphanumeric + spaces
  return trimmed.length >= 1 && trimmed.length <= 100 && /^[a-zA-Z0-9\s\u00C0-\u024F\u1E00-\u1EFF]+$/.test(trimmed);
}
