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
    id:              String!
    title:           String!
    description:     String
    youtubeUrl:      String!
    youtubeVideoId:  String
    status:          String!
    progressCurrent: Int!
    progressTotal:   Int!
    createdAt:       String!
    updatedAt:       String!
  }

  input CreateLectureInput {
    title:       String!
    description: String
    youtubeUrl:  String!
    # The lecture's AI agent profile is created together with the lecture
    # (see lecture.service.ts createLecture); chat serves it once the
    # dataset reaches READY.
    agentName:         String!
    agentInstructions: String!
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
    sessionId: Int!
  }

  type ChatSession {
    id:            Int!
    title:         String!
    messageCount:  Int!
    firstQuestion: String
    createdAt:     String!
    updatedAt:     String!
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
    id:           Int!
    question:     String!
    answer:       String!
    sources:      [ChunkSource!]!
    createdAt:    String!
    displayLabel: String
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
    lectureId:    Int!
    lectureTitle: String!
    question:     String!
    createdAt:    String!
  }

  type RecentQuestionPage {
    items:   [RecentQuestion!]!
    total:   Int!
    hasMore: Boolean!
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

  # One page of students (AD6). total = rows matching the filters; the
  # summary counts cover every student.
  type StudentPage {
    items:         [StudentEntry!]!
    total:         Int!
    hasMore:       Boolean!
    totalStudents: Int!
    activeCount:   Int!
    inactiveCount: Int!
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

  # One page of users (AD6); the summary counts cover every user.
  type UserPage {
    items:        [UserManagementEntry!]!
    total:        Int!
    hasMore:      Boolean!
    totalUsers:   Int!
    studentCount: Int!
    adminCount:   Int!
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

  type QnaChunkPage {
    items:   [QnaChunk!]!
    total:   Int!
    hasMore: Boolean!
  }

  # ── AI Agent Detail ────────────────────────────────────
  type LectureAgentDetail {
    id:         Int!
    title:      String!
    status:     String!
    # Embedded pieces in the live dataset (a long answer is several pieces).
    chunkCount: Int!
    # Q&A pairs in the live dataset — what the lecture page lists.
    qaCount:    Int!
    createdAt:  String!
    updatedAt:  String!
    # Operational readiness (additive): status is dataset processing only.
    # agentProfileStatus: ACTIVE | INACTIVE | MISSING.
    # chatReady: status READY AND an active agent profile AND a fully embedded
    # active dataset version (what chat will serve).
    # notReadyReason: why the dataset is not ready (null when it is).
    agentProfileStatus: String!
    chatReady:          Boolean!
    notReadyReason:     String
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
    # One page of questions (newest first); questionCount is the total.
    questions:       [JourneyQuestion!]!
    hasMoreQuestions: Boolean!
    byLecture:       [LectureEngagement!]!
  }

  # ── Content Gap ────────────────────────────────────────
  type LectureGapAnalysis {
    lectureId:           Int!
    lectureTitle:        String!
    questionsAsked:      Int!
    chunkCount:          Int!
    coverageScore:       Float!
    gapTopics:           [String!]!
    coveredTopics:       [String!]!
    status:              String!
    answeredFromLecture: Int!
    notInLecture:        Int!
    # Analysis covers questions from the last windowDays days; sampled = the
    # window held more questions than were analysed (newest 20,000 used).
    sampled:             Boolean!
    # Only part of the lecture's Q&As were compared (the per-lecture cap).
    chunksSampled:       Boolean!
    windowDays:          Int!
  }

  type DayActivity {
    day:   String!
    date:  String!
    count: Int!
  }

  type LectureActivity {
    lectureId:    Int!
    lectureTitle: String!
    count:        Int!
  }

  type RecentStudentQuestion {
    question:     String!
    lectureTitle: String!
    createdAt:    String!
  }

  type StudentStats {
    totalQuestions:         Int!
    totalSessions:          Int!
    lecturesEngaged:        Int!
    totalAvailableLectures: Int!
    lastActive:             String
    memberSince:            String
    learningStreak:         Int!
    mostAskedTopic:         String
    activityBadge:          String!
    thisWeekQuestions:      Int!
    lastWeekQuestions:      Int!
    weeklyActivity:         [DayActivity!]!
    lectureBreakdown:       [LectureActivity!]!
    peakHour:               Int
  }

  # ── Queries ───────────────────────────────────────────
  type Query {
    myStats: StudentStats!
    lectures:                        [Lecture!]!
    lecture(id: String!):            Lecture!
    chatSessions(lectureId: Int!):                                            [ChatSession!]!
    sessionHistory(sessionId: Int!):                                          [ChatHistoryEntry!]!
    chatHistory(lectureId: Int!):                                            [ChatHistoryEntry!]!
    paginatedChatHistory(lectureId: Int!, limit: Int!, offset: Int!):        ChatHistoryPage!
    searchChatHistory(lectureId: Int!, query: String!):                      [ChatHistoryEntry!]!
    analyticsSummary:                AnalyticsSummary!
    questionsPerLecture:             [QuestionPerLecture!]!
    # Newest first. limit defaults to 10 and is capped at 100.
    recentQuestions(limit: Int):     [RecentQuestion!]!
    # One page (limit capped at 200), filtered by question/student-name text and lecture.
    recentQuestionsPage(limit: Int!, offset: Int!, search: String, lectureId: Int): RecentQuestionPage!
    lectureStatusList:               [LectureStatusEntry!]!
    # Paged (AD6): limit default 25, at most 100.
    registeredStudents(limit: Int, offset: Int, search: String, status: String): StudentPage!
    allUsers(limit: Int, offset: Int, search: String, role: String): UserPage!
    lectureChunks(lectureId: Int!, limit: Int, offset: Int, search: String): QnaChunkPage!
    lectureAgentDetails:             [LectureAgentDetail!]!
    studentJourney(id: String!, limit: Int, offset: Int): StudentJourney!
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
    createChatSession(lectureId: Int!):                           ChatSession!
    deleteChatSession(id: Int!):                                  Boolean!
    renameChatSession(id: Int!, title: String!):                  Boolean!
    deleteChatEntry(id: Int!):                                    Boolean!
    renameChatEntry(id: Int!, label: String!):                    Boolean!
    deleteUser(id: String!):                                      Boolean!
    updateUserRole(id: String!, role: String!):                   UserManagementEntry!
    updateAdminProfile(name: String, currentPassword: String, newPassword: String): AuthUserPayload!
  }
`;
