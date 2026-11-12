// Separate mutation: the server derives the course and lecture IDs from an
// owned completed quiz, rather than trusting a caller-supplied retake scope.
export const practiceQuizRetakeTypeDefs = `#graphql
  extend type Mutation {
    retakePracticeQuiz(id: Int!): PracticeQuiz!
  }
`;
