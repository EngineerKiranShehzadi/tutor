import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const transporter = nodemailer.createTransport({
  host:   env.EMAIL.HOST,
  port:   env.EMAIL.PORT,
  secure: env.EMAIL.SECURE,
  auth: {
    user: env.EMAIL.USER,
    pass: env.EMAIL.PASSWORD,
  },
});

const FROM = `"${env.EMAIL.FROM_NAME}" <${env.EMAIL.USER}>`;

// ── OTP EMAIL ─────────────────────────────────────────
export const sendPasswordResetOtp = async (
  to: string,
  userName: string,
  otp: string
): Promise<void> => {
  await transporter.sendMail({
    from:    FROM,
    to,
    subject: 'Password Reset OTP — AskAITutor',
    text:    `Your AskAITutor password reset OTP is: ${otp}. It expires in 60 seconds.`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body     { font-family: 'Segoe UI', sans-serif; background: #f9f9f9; margin: 0; padding: 0; }
    .wrapper { max-width: 520px; margin: 40px auto; background: #fff; border-radius: 14px;
               box-shadow: 0 4px 24px rgba(0,0,0,.08); overflow: hidden; }
    .header  { background: #ff0000; padding: 28px 32px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.3px; }
    .body    { padding: 32px; color: #333; }
    .body p  { line-height: 1.6; margin: 0 0 16px; }
    .otp-box { background: #f7f7f7; border: 2px dashed #ff0000; border-radius: 12px;
               text-align: center; padding: 24px 16px; margin: 20px 0; }
    .otp-code { font-size: 44px; font-weight: 900; letter-spacing: 14px; color: #ff0000;
                font-family: 'Courier New', monospace; }
    .note    { font-size: 12px; color: #888; border-top: 1px solid #eee; padding-top: 16px; }
    .footer  { background: #f2f2f2; padding: 16px 32px; text-align: center;
               font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header"><h1>AskAI<span style="color:#ffe0e0">Tutor</span></h1></div>
    <div class="body">
      <p>Hi <strong>${userName}</strong>,</p>
      <p>Use the OTP below to reset your AskAITutor password:</p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
      </div>
      <p>This OTP expires in <strong>60 seconds</strong>. Do not share it with anyone.</p>
      <p class="note">
        If you didn't request a password reset, you can safely ignore this email — your account is secure.
      </p>
    </div>
    <div class="footer">© ${new Date().getFullYear()} AskAITutor. All rights reserved.</div>
  </div>
</body>
</html>`,
  });

  logger.info(`Password reset OTP email sent to ${to}`);
};

// ── SIGNUP VERIFICATION OTP EMAIL ─────────────────────
export const sendSignupVerificationOtp = async (
  to: string,
  userName: string,
  otp: string
): Promise<void> => {
  await transporter.sendMail({
    from:    FROM,
    to,
    subject: 'Verify your AskAITutor account',
    text:    `Your AskAITutor email verification code is: ${otp}. It expires in 60 seconds.`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body     { font-family: 'Segoe UI', sans-serif; background: #f9f9f9; margin: 0; padding: 0; }
    .wrapper { max-width: 520px; margin: 40px auto; background: #fff; border-radius: 14px;
               box-shadow: 0 4px 24px rgba(0,0,0,.08); overflow: hidden; }
    .header  { background: #ff0000; padding: 28px 32px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.3px; }
    .body    { padding: 32px; color: #333; }
    .body p  { line-height: 1.6; margin: 0 0 16px; }
    .otp-box { background: #f7f7f7; border: 2px dashed #ff0000; border-radius: 12px;
               text-align: center; padding: 24px 16px; margin: 20px 0; }
    .otp-code { font-size: 44px; font-weight: 900; letter-spacing: 14px; color: #ff0000;
                font-family: 'Courier New', monospace; }
    .note    { font-size: 12px; color: #888; border-top: 1px solid #eee; padding-top: 16px; }
    .footer  { background: #f2f2f2; padding: 16px 32px; text-align: center;
               font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header"><h1>AskAI<span style="color:#ffe0e0">Tutor</span></h1></div>
    <div class="body">
      <p>Hi <strong>${userName}</strong>,</p>
      <p>Welcome! Use the code below to verify your email address and complete your registration:</p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
      </div>
      <p>This code expires in <strong>60 seconds</strong>. Do not share it with anyone.</p>
      <p class="note">
        If you didn't create an AskAITutor account, you can safely ignore this email.
      </p>
    </div>
    <div class="footer">© ${new Date().getFullYear()} AskAITutor. All rights reserved.</div>
  </div>
</body>
</html>`,
  });

  logger.info(`Signup verification OTP email sent to ${to}`);
};

// ── TRANSPORT VERIFY ──────────────────────────────────
export const verifyEmailTransport = async (): Promise<void> => {
  await transporter.verify();
  logger.info('Email transporter ready');
};
