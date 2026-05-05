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

// ── SHARED EMAIL WRAPPER ───────────────────────────────
const emailHtml = (userName: string, heading: string, subtext: string, otp: string, note: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body     { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8; margin: 0; padding: 0; }
    .wrapper { max-width: 520px; margin: 40px auto; border-radius: 16px; overflow: hidden;
               box-shadow: 0 8px 32px rgba(6,95,212,0.15); }
    .header  { background: #060d1f; padding: 28px 32px; text-align: center; }
    .logo-row { display: inline-flex; align-items: center; gap: 10px; }
    .logo-icon { display: inline-block; width: 40px; height: 40px; background: linear-gradient(135deg,#065fd4,#1a7fe8);
                 border-radius: 10px; text-align: center; line-height: 40px; font-size: 20px; }
    .logo-text { font-size: 22px; font-weight: 900; color: #ffffff; letter-spacing: -0.3px; }
    .logo-text span { color: #60a5fa; }
    .banner  { background: linear-gradient(135deg,#065fd4,#1a7fe8); padding: 18px 32px; text-align: center; }
    .banner p { color: rgba(255,255,255,0.9); margin: 0; font-size: 13px; font-weight: 600;
                letter-spacing: 0.5px; text-transform: uppercase; }
    .body    { background: #ffffff; padding: 36px 32px; color: #1e293b; }
    .body p  { line-height: 1.7; margin: 0 0 16px; font-size: 15px; }
    .otp-box { background: #eff6ff; border: 2px dashed #065fd4; border-radius: 14px;
               text-align: center; padding: 28px 16px; margin: 24px 0; }
    .otp-label { font-size: 11px; font-weight: 700; color: #065fd4; text-transform: uppercase;
                 letter-spacing: 1.5px; margin-bottom: 10px; }
    .otp-code { font-size: 46px; font-weight: 900; letter-spacing: 16px; color: #065fd4;
                font-family: 'Courier New', monospace; }
    .expire-badge { display: inline-block; background: #fef3c7; border: 1px solid #fcd34d;
                    color: #92400e; font-size: 12px; font-weight: 700; border-radius: 20px;
                    padding: 4px 14px; margin-top: 10px; }
    .note    { font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 16px; margin-top: 8px; }
    .footer  { background: #060d1f; padding: 18px 32px; text-align: center; }
    .footer p { font-size: 12px; color: #475569; margin: 0; }
    .footer span { color: #60a5fa; font-weight: 700; }
  </style>
</head>
<body>
  <div class="wrapper">
    <!-- Header: dark navy with logo -->
    <div class="header">
      <div class="logo-row">
        <div class="logo-icon">🤖</div>
        <div class="logo-text">AskAI<span>Tutor</span></div>
      </div>
    </div>
    <!-- Blue banner -->
    <div class="banner"><p>${heading}</p></div>
    <!-- Body -->
    <div class="body">
      <p>Hi <strong>${userName}</strong>,</p>
      <p>${subtext}</p>
      <div class="otp-box">
        <div class="otp-label">Your Verification Code</div>
        <div class="otp-code">${otp.split('').join(' ')}</div>
        <div class="expire-badge">⏱ Expires in 60 seconds</div>
      </div>
      <p class="note">${note}</p>
    </div>
    <!-- Footer: dark navy -->
    <div class="footer">
      <p>© ${new Date().getFullYear()} <span>AskAITutor</span> · Lecture-scoped AI Tutoring Platform</p>
    </div>
  </div>
</body>
</html>`;

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
    html: emailHtml(
      userName,
      'Password Reset Request',
      'Use the OTP below to reset your AskAITutor password:',
      otp,
      "If you didn't request a password reset, you can safely ignore this email — your account is secure."
    ),
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
    html: emailHtml(
      userName,
      'Email Verification',
      'Welcome! Use the code below to verify your email address and complete your registration:',
      otp,
      "If you didn't create an AskAITutor account, you can safely ignore this email."
    ),
  });

  logger.info(`Signup verification OTP email sent to ${to}`);
};

// ── TRANSPORT VERIFY ──────────────────────────────────
export const verifyEmailTransport = async (): Promise<void> => {
  await transporter.verify();
  logger.info('Email transporter ready');
};
