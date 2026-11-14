// Faculty-owned metadata is additive; future LMS/CASE adapters can map stable external IDs.
export const learningOutcomeTypeDefs = `#graphql
  type CourseLearningOutcome {
    id: Int!
    courseId: Int!
    code: String!
    description: String!
    externalGuid: String
    lectureIds: [Int!]!
  }
  type LearningOutcomeQuestion {
    questionId: Int!
    lectureId: Int!
    lectureTitle: String!
    question: String!
    outcomeId: Int
  }
  type StudentOutcomeProgress {
    outcomeId: Int!
    code: String!
    description: String!
    attempted: Int!
    correct: Int!
    percent: Int
    status: String!
    lectureIds: [Int!]!
  }
  type FacultyOutcomeSummary {
    outcomeId: Int!
    code: String!
    description: String!
    attempted: Int!
    correct: Int!
    students: Int!
    percent: Int
  }
  extend type Query {
    courseLearningOutcomes(courseId:Int!): [CourseLearningOutcome!]!
    myOutcomeProgress(courseId:Int!): [StudentOutcomeProgress!]!
    facultyOutcomeSummary(courseId:Int!): [FacultyOutcomeSummary!]!
    learningOutcomeQuestions(courseId:Int!,limit:Int): [LearningOutcomeQuestion!]!
  }
  extend type Mutation {
    createLearningOutcome(courseId:Int!,code:String!,description:String!): [CourseLearningOutcome!]!
    updateLearningOutcome(id:Int!,description:String!): [CourseLearningOutcome!]!
    setLectureLearningOutcome(courseId:Int!,lectureId:Int!,outcomeId:Int!,selected:Boolean!): [CourseLearningOutcome!]!
    mapPracticeQuestionOutcome(courseId:Int!,questionId:Int!,outcomeId:Int!): Boolean!
    unmapPracticeQuestionOutcome(courseId:Int!,questionId:Int!): Boolean!
  }
`;
