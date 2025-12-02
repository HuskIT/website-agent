/**
 * Email validation utilities
 */

// RFC 5322 compliant email regex (simplified)
const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // Basic checks
  if (email.length > 254) {
    return false;
  }

  // Check format
  if (!EMAIL_REGEX.test(email)) {
    return false;
  }

  // Check local and domain parts
  const parts = email.split('@');

  if (parts.length !== 2) {
    return false;
  }

  const [local, domain] = parts;

  // Local part should be <= 64 chars
  if (local.length > 64) {
    return false;
  }

  // Domain should have at least one dot and valid TLD
  if (!domain.includes('.') || domain.endsWith('.')) {
    return false;
  }

  return true;
}

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

  if (!/[a-z]/.test(password)) {
    errors.push('Mật khẩu phải có ít nhất 1 chữ thường');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Mật khẩu phải có ít nhất 1 chữ hoa');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Mật khẩu phải có ít nhất 1 số');
  }

  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Mật khẩu phải có ít nhất 1 ký tự đặc biệt');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function sanitizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
