import { GraphQLError } from 'graphql';
import { Request } from 'express';
import { AppError } from '../../middleware/errorHandler';
import * as AuthService from '../../services/auth.service';
import { GraphQLContext } from '../context';

// ── In-memory rate limiter (per mutation, per IP) ─────
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

const checkRateLimit = (req: Request, prefix: string, max: number, windowMs: number): void => {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  const key = `${prefix}:${ip}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt < now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (entry.count >= max) {
    throw new GraphQLError('Too many requests. Please try again later.', {
      extensions: { code: 'RATE_LIMITED' },
    });
  }
  entry.count++;
};

// ── Convert AppError → GraphQLError ──────────────────
const toGQL = (err: unknown): never => {
  if (err instanceof GraphQLError) throw err;
  if (err instanceof AppError) {
    throw new GraphQLError(err.message, {
      extensions: { code: 'BAD_REQUEST', statusCode: err.statusCode },
    });
  }
  throw new GraphQLError('Internal server error', {
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  });
};

// ── Input types ───────────────────────────────────────
interface RequestPasswordResetInput  { email: string }
interface ResendPasswordResetOtpInput { email: string }
interface VerifyOtpInput              { email: string; code: string }
interface ResetPasswordInput          { email: string; newPassword: string; confirmPassword: string }

interface SignupInput         { name: string; email: string; password: string }
interface ResendSignupOtpInput { email: string }
interface VerifySignupOtpInput { email: string; code: string }

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env['NODE_ENV'] === 'production',
  sameSite: 'strict' as const,
  maxAge:   7 * 24 * 60 * 60 * 1000,
};

// ── Resolvers ─────────────────────────────────────────
export const resolvers = {
  Query: {},

  Mutation: {
    // 2 req/min
    requestPasswordReset: async (
      _: unknown,
      { input }: { input: RequestPasswordResetInput },
      ctx: GraphQLContext
    ) => {
      checkRateLimit(ctx.req, 'rpr', 2, 60_000);
      await AuthService.requestPasswordReset(input.email).catch(toGQL);
      return { success: true, message: 'OTP sent to your email. Valid for 60 seconds.' };
    },

    // 2 req/min
    resendPasswordResetOtp: async (
      _: unknown,
      { input }: { input: ResendPasswordResetOtpInput },
      ctx: GraphQLContext
    ) => {
      checkRateLimit(ctx.req, 'rrpo', 2, 60_000);
      await AuthService.resendPasswordResetOtp(input.email).catch(toGQL);
      return { success: true, message: 'New OTP sent to your email.' };
    },

    // 3 req/min
    verifyOtp: async (
      _: unknown,
      { input }: { input: VerifyOtpInput },
      ctx: GraphQLContext
    ) => {
      checkRateLimit(ctx.req, 'vo', 3, 60_000);
      await AuthService.verifyOtp(input.email, input.code).catch(toGQL);
      return { success: true, message: 'OTP verified successfully.' };
    },

    // 3 req/min
    resetPassword: async (
      _: unknown,
      { input }: { input: ResetPasswordInput },
      ctx: GraphQLContext
    ) => {
      checkRateLimit(ctx.req, 'rp', 3, 60_000);
      await AuthService.resetPasswordWithOtp(
        input.email,
        input.newPassword,
        input.confirmPassword
      ).catch(toGQL);
      return { success: true, message: 'Password reset successfully.' };
    },

    // ── Signup OTP ──────────────────────────────────
    // 3 req/min
    signup: async (
      _: unknown,
      { input }: { input: SignupInput },
      ctx: GraphQLContext
    ) => {
      checkRateLimit(ctx.req, 'su', 3, 60_000);
      return await AuthService.signupUser(input.name, input.email, input.password).catch(toGQL);
    },

    // 2 req/min
    resendSignupOtp: async (
      _: unknown,
      { input }: { input: ResendSignupOtpInput },
      ctx: GraphQLContext
    ) => {
      checkRateLimit(ctx.req, 'rsuo', 2, 60_000);
      await AuthService.resendSignupOtp(input.email).catch(toGQL);
      return { success: true, message: 'New verification code sent to your email.' };
    },

    // 3 req/min
    verifySignupOtp: async (
      _: unknown,
      { input }: { input: VerifySignupOtpInput },
      ctx: GraphQLContext
    ) => {
      checkRateLimit(ctx.req, 'vsuo', 3, 60_000);
      const { accessToken, refreshToken, user } =
        await AuthService.verifySignupOtp(input.email, input.code).catch(toGQL);
      ctx.res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
      return { accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
    },
  },
};
