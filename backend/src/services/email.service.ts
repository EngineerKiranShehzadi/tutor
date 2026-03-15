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

export const sendPasswordResetEmail = async (
  to: string,
  userName: string,
  resetToken: string
): Promise<void> => {
  const resetUrl = `${env.FRONTEND_URL}/reset-password/${resetToken}`;

  await transporter.sendMail({
    from:    FROM,
    to,
    subject: 'Reset your AskAITutor password',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body { font-family: 'Segoe UI', sans-serif; background: #f9f9f9; margin: 0; padding: 0; }
    .wrapper { max-width: 520px; margin: 40px auto; background: #fff; border-radius: 14px;
               box-shadow: 0 4px 24px rgba(0,0,0,.08); overflow: hidden; }
    .header  { background: #ff0000; padding: 28px 32px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.3px; }
    .body    { padding: 32px; color: #333; }
    .body p  { line-height: 1.6; margin: 0 0 16px; }
    .btn     { display: inline-block; background: #ff0000; color: #fff !important;
               padding: 13px 28px; border-radius: 8px; text-decoration: none;
               font-weight: 700; font-size: 15px; margin: 8px 0 20px; }
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
      <p>We received a request to reset the password for your AskAITutor account.</p>
      <p>Click the button below to set a new password:</p>
      <a href="${resetUrl}" class="btn">Reset Password</a>
      <p>This link will expire in <strong>1 hour</strong>.</p>
      <p class="note">
        If you didn't request a password reset, you can safely ignore this email — your account is secure.<br/><br/>
        Or copy this link: <a href="${resetUrl}">${resetUrl}</a>
      </p>
    </div>
    <div class="footer">© ${new Date().getFullYear()} AskAITutor. All rights reserved.</div>
  </div>
</body>
</html>`,
  });

  logger.info(`Password reset email sent to ${to}`);
};

export const verifyEmailTransport = async (): Promise<void> => {
  await transporter.verify();
  logger.info('Email transporter ready');
};
