export const revisionPlanTypeDefs = `#graphql
 type FacultyRevisionPlan {
  outcomeId:Int! code:String! description:String!
  lectureId:Int! lectureTitle:String! guidance:String! status:String! approvedAt:String
 }
 type StudentRevisionRecommendation {
  outcomeId:Int! code:String! description:String! lectureId:Int! lectureTitle:String!
  guidance:String! attempted:Int! correct:Int!
 }
 extend type Query {
  facultyRevisionPlans(courseId:Int!):[FacultyRevisionPlan!]!
  myRevisionRecommendations(courseId:Int!):[StudentRevisionRecommendation!]!
 }
 extend type Mutation {
  saveRevisionPlan(courseId:Int!,outcomeId:Int!,lectureId:Int!,guidance:String!,approve:Boolean!):[FacultyRevisionPlan!]!
  withdrawRevisionPlan(courseId:Int!,outcomeId:Int!):[FacultyRevisionPlan!]!
 }
`;
