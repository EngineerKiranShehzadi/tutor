// Faculty-facing descriptive evidence: never a predictive or official academic decision.
export const facultyLearningGapTypeDefs = `#graphql
  type FacultyLearningGap {
    outcomeId: Int!
    code: String!
    description: String!
    mappedQuestions: Int!
    assessedStudents: Int
    eligibleStudents: Int
    revisionStudents: Int
    answerAccuracyPercent: Int
    revisionPercent: Int
    lectureIds: [Int!]!
    status: String!
    recommendation: String!
  }
  extend type Query { facultyLearningGaps(courseId: Int!): [FacultyLearningGap!]! }
`;
