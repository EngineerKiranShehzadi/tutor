export const misconceptionTypeDefs = `#graphql
 type MisconceptionTag { id:Int! outcomeId:Int! code:String! description:String! }
 type MisconceptionOptionMapping { optionIndex:Int! misconceptionId:Int! }
 type MisconceptionQuestionReview {questionId:Int! question:String! options:[String!]! correctIndex:Int! outcomeId:Int mappings:[MisconceptionOptionMapping!]!}
 type StudentMisconceptionEvidence {id:Int! outcomeId:Int! outcomeCode:String! code:String! description:String! occurrences:Int! attempts:Int! repeated:Boolean! lastSeen:String}
 type StudentOutcomeTimeline {outcomeId:Int! code:String! quizId:Int! submittedAt:String! attempted:Int! correct:Int!}
 extend type Query {
   courseMisconceptions(courseId:Int!):[MisconceptionTag!]!
   misconceptionQuestionReview(courseId:Int!,limit:Int):[MisconceptionQuestionReview!]!
   myMisconceptionEvidence(courseId:Int!):[StudentMisconceptionEvidence!]!
   myOutcomeTimeline(courseId:Int!):[StudentOutcomeTimeline!]!
 }
 extend type Mutation {
   createMisconception(courseId:Int!,outcomeId:Int!,code:String!,description:String!):[MisconceptionTag!]!
   setDistractorMisconception(courseId:Int!,questionId:Int!,optionIndex:Int!,misconceptionId:Int):Boolean!
 }
`;
