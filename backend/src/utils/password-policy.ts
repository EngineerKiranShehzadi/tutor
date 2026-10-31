import { AppError } from '../middleware/errorHandler';

// bcrypt only considers the first 72 BYTES of a password and silently ignores
// everything after that, so a longer password is not fully protected and the
// user is never told. Reject it rather than accept it misleadingly.
export const MAX_PASSWORD_BYTES = 72;

// One rule set for every path that sets a password (signup, OTP reset, profile
// change, admin profile change). It mirrors the browser rules in the signup form,
// so a normal user sees no change. `subject` lets a caller keep its own
// wording ("Password" vs "New password") without forking the rules.
export const validatePassword = (password: string | null | undefined, subject = 'Password'): void => {
  const pw = password ?? '';
  if (pw.length < 8)      throw new AppError(`${subject} must be at least 8 characters`, 400);
  if (!/[A-Z]/.test(pw))  throw new AppError(`${subject} must contain an uppercase letter`, 400);
  if (!/[0-9]/.test(pw))  throw new AppError(`${subject} must contain a number`, 400);
  if (Buffer.byteLength(pw, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new AppError(`${subject} must be ${MAX_PASSWORD_BYTES} characters or fewer`, 400);
  }
};
