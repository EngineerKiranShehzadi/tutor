import { gql } from '@apollo/client';

export const REQUEST_PASSWORD_RESET_MUTATION = gql`
  mutation RequestPasswordReset($input: RequestPasswordResetInput!) {
    requestPasswordReset(input: $input) {
      success
      message
    }
  }
`;

export const RESEND_PASSWORD_RESET_OTP_MUTATION = gql`
  mutation ResendPasswordResetOtp($input: ResendPasswordResetOtpInput!) {
    resendPasswordResetOtp(input: $input) {
      success
      message
    }
  }
`;

export const VERIFY_OTP_MUTATION = gql`
  mutation VerifyOtp($input: VerifyOtpInput!) {
    verifyOtp(input: $input) {
      success
      message
    }
  }
`;

export const RESET_PASSWORD_MUTATION = gql`
  mutation ResetPassword($input: ResetPasswordInput!) {
    resetPassword(input: $input) {
      success
      message
    }
  }
`;

export const SIGNUP_MUTATION = gql`
  mutation Signup($input: SignupInput!) {
    signup(input: $input) {
      email
      message
    }
  }
`;

export const RESEND_SIGNUP_OTP_MUTATION = gql`
  mutation ResendSignupOtp($input: ResendSignupOtpInput!) {
    resendSignupOtp(input: $input) {
      success
      message
    }
  }
`;

export const VERIFY_SIGNUP_OTP_MUTATION = gql`
  mutation VerifySignupOtp($input: VerifySignupOtpInput!) {
    verifySignupOtp(input: $input) {
      accessToken
      user {
        id
        name
        email
        role
      }
    }
  }
`;
