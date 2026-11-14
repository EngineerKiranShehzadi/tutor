export const learningEffectivenessTypeDefs = `#graphql
 type ObservedLearningProgress {
  outcomeId:Int! code:String! description:String! eligibleQuizCount:Int!
  firstQuizId:Int latestQuizId:Int
  firstPercent:Float latestPercent:Float changePoints:Float
  firstSubmittedAt:String latestSubmittedAt:String interpretation:String!
 }
 extend type Query { myObservedLearningProgress(courseId:Int!):[ObservedLearningProgress!]! }
`;
