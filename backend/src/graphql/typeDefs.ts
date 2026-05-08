export const typeDefs = `#graphql

  # ── Common ───────────────────────────────────────────
  type SuccessResponse {
    success: Boolean!
    message: String!
  }

  # ── Auth inputs ───────────────────────────────────────
  input RequestPasswordResetInput  { email: String! }
  input ResendPasswordResetOtpInput { email: String! }
  input VerifyOtpInput { email: String!, code: String! }
  input ResetPasswordInput {
    email:           String!
    newPassword:     String!
    confirmPassword: String!
  }
  input SignupInput { name: String!, email: String!, password: String! }
  input ResendSignupOtpInput  { email: String! }
  input VerifySignupOtpInput  { email: String!, code: String! }

  type SignupInitiatedPayload { email: String!, message: String! }
  type AuthUserPayload { id: String!, name: String!, email: String!, role: String! }
  type SignupVerifyPayload { accessToken: String!, user: AuthUserPayload! }

  # ── Lecture ───────────────────────────────────────────
  type Lecture {
    id:             String!
    title:          String!
    description:    String
    youtubeUrl:     String!
    youtubeVideoId: String
    status:         String!
    createdAt:      String!
    updatedAt:      String!
  }

  input CreateLectureInput {
    title:       String!
    description: String
    youtubeUrl:  String!
  }

  input UpdateLectureInput {
    title:       String
    description: String
    youtubeUrl:  String
  }

  # ── Chat / RAG ────────────────────────────────────────
  input AskLectureAgentInput {
    lectureId: Int!
    question:  String!
  }

  type ChunkSource {
    id:        Int!
    topic:     String
    question:  String!
    startTime: String
    endTime:   String
  }

  type ChatAnswerResponse {
    answer:  String!
    sources: [ChunkSource!]!
  }

  type ChatHistoryPage {
    entries: [ChatHistoryEntry!]!
    total:   Int!
    hasMore: Boolean!
  }

  type ChatHistoryEntry {
    id:        Int!
    question:  String!
    answer:    String!
    sources:   [ChunkSource!]!
    createdAt: String!
  }

  # ── Analytics ─────────────────────────────────────────
  type AnalyticsSummary {
    totalStudents:  Int!
    totalLectures:  Int!
    totalQuestions: Int!
    readyAgents:    Int!
  }

  type QuestionPerLecture {
    lectureId:    Int!
    lectureTitle: String!
    count:        Int!
  }

  type RecentQuestion {
    id:           Int!
    studentName:  String!
    studentEmail: String!
    lectureTitle: String!
    question:     String!
    createdAt:    String!
  }

  type LectureStatusEntry {
    id:     Int!
    title:  String!
    status: String!
  }

  type StudentEntry {
    id:            String!
    name:          String!
    email:         String!
    createdAt:     String!
    questionCount: Int!
    status:        String!
  }

  # ── User Management ───────────────────────────────────
  type UserManagementEntry {
    id:         String!
    name:       String!
    email:      String!
    role:       String!
    isVerified: Boolean!
    createdAt:  String!
  }

  # ── Q&A Chunks (dataset preview) ──────────────────────
  type QnaChunk {
    id:        Int!
    topic:     String
    question:  String!
    answer:    String!
    startTime: String
    endTime:   String
    keywords:  String
  }

  # ── AI Agent Detail ────────────────────────────────────
  type LectureAgentDetail {
    id:         Int!
    title:      String!
    status:     String!
    chunkCount: Int!
    createdAt:  String!
    updatedAt:  String!
  }

  # ── Student Journey ───────────────────────────────────
  type JourneyQuestion {
    id:           Int!
    question:     String!
    lectureTitle: String!
    lectureId:    Int!
    createdAt:    String!
  }

  type LectureEngagement {
    lectureId:     Int!
    lectureTitle:  String!
    questionCount: Int!
    firstAsked:    String!
    lastAsked:     String!
  }

  type StudentJourney {
    studentId:       String!
    studentName:     String!
    studentEmail:    String!
    status:          String!
    questionCount:   Int!
    lecturesEngaged: Int!
    joinedAt:        String!
    firstActivity:   String
    lastActivity:    String
    questions:       [JourneyQuestion!]!
    byLecture:       [LectureEngagement!]!
  }

  # ── Content Gap ────────────────────────────────────────
  type LectureGapAnalysis {
    lectureId:      Int!
    lectureTitle:   String!
    questionsAsked: Int!
    chunkCount:     Int!
    coverageScore:  Float!
    gapTopics:      [String!]!
    coveredTopics:  [String!]!
    status:         String!
  }

  # ── Queries ───────────────────────────────────────────
  type Query {
    lectures:                        [Lecture!]!
    lecture(id: String!):            Lecture!
    chatHistory(lectureId: Int!):                                            [ChatHistoryEntry!]!
    paginatedChatHistory(lectureId: Int!, limit: Int!, offset: Int!):        ChatHistoryPage!
    searchChatHistory(lectureId: Int!, query: String!):                      [ChatHistoryEntry!]!
    analyticsSummary:                AnalyticsSummary!
    questionsPerLecture:             [QuestionPerLecture!]!
    recentQuestions(limit: Int):     [RecentQuestion!]!
    lectureStatusList:               [LectureStatusEntry!]!
    registeredStudents:              [StudentEntry!]!
    allUsers:                        [UserManagementEntry!]!
    lectureChunks(lectureId: Int!):  [QnaChunk!]!
    lectureAgentDetails:             [LectureAgentDetail!]!
    studentJourney(id: String!):     StudentJourney!
    contentGaps:                     [LectureGapAnalysis!]!
  }

  # ── Mutations ─────────────────────────────────────────
  type Mutation {
    requestPasswordReset(input: RequestPasswordResetInput!):      SuccessResponse!
    resendPasswordResetOtp(input: ResendPasswordResetOtpInput!):  SuccessResponse!
    verifyOtp(input: VerifyOtpInput!):                            SuccessResponse!
    resetPassword(input: ResetPasswordInput!):                    SuccessResponse!
    signup(input: SignupInput!):                                  SignupInitiatedPayload!
    resendSignupOtp(input: ResendSignupOtpInput!):                SuccessResponse!
    verifySignupOtp(input: VerifySignupOtpInput!):                SignupVerifyPayload!
    createLecture(input: CreateLectureInput!):                    Lecture!
    updateLecture(id: String!, input: UpdateLectureInput!):       Lecture!
    deleteLecture(id: String!):                                   Boolean!
    askLectureAgent(input: AskLectureAgentInput!):                ChatAnswerResponse!
    clearChat(lectureId: Int!):                                   SuccessResponse!
    deleteChatEntry(id: Int!):                                    Boolean!
    renameChatEntry(id: Int!, label: String!):                    Boolean!
    deleteUser(id: String!):                                      Boolean!
    updateUserRole(id: String!, role: String!):                   UserManagementEntry!
    updateAdminProfile(name: String, currentPassword: String, newPassword: String): AuthUserPayload!
  }
`;
