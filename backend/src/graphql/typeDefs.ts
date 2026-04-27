export const typeDefs = `#graphql
  type SuccessResponse {
    success: Boolean!
    message: String!
  }

  # ── Password reset ───────────────────────────────────
  input RequestPasswordResetInput {
    email: String!
  }

  input ResendPasswordResetOtpInput {
    email: String!
  }

  input VerifyOtpInput {
    email: String!
    code: String!
  }

  input ResetPasswordInput {
    email: String!
    newPassword: String!
    confirmPassword: String!
  }

  # ── Signup OTP ───────────────────────────────────────
  input SignupInput {
    name: String!
    email: String!
    password: String!
  }

  input ResendSignupOtpInput {
    email: String!
  }

  input VerifySignupOtpInput {
    email: String!
    code: String!
  }

  type SignupInitiatedPayload {
    email: String!
    message: String!
  }

  type AuthUserPayload {
    id: String!
    name: String!
    email: String!
  }

  type SignupVerifyPayload {
    accessToken: String!
    user: AuthUserPayload!
  }

  # ── Chat / RAG ───────────────────────────────────────
  input SendChatMessageInput {
    lectureId: String!
    message:   String!
  }

  type LectureSource {
    id:    String!
    title: String!
  }

  type ChatResponse {
    explanation: String!
    agentName:   String!
    sources:     [LectureSource!]!
  }

  type Query {
    _dummy: Boolean
  }

  type Mutation {
    # Chat
    sendChatMessage(input: SendChatMessageInput!): ChatResponse!
    # Password reset
    requestPasswordReset(input: RequestPasswordResetInput!): SuccessResponse!
    resendPasswordResetOtp(input: ResendPasswordResetOtpInput!): SuccessResponse!
    verifyOtp(input: VerifyOtpInput!): SuccessResponse!
    resetPassword(input: ResetPasswordInput!): SuccessResponse!

    # Signup OTP
    signup(input: SignupInput!): SignupInitiatedPayload!
    resendSignupOtp(input: ResendSignupOtpInput!): SuccessResponse!
    verifySignupOtp(input: VerifySignupOtpInput!): SignupVerifyPayload!
  }
`;
