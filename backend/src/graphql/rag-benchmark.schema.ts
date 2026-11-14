// Metrics are scored server-side from a reviewed golden/prediction pair.
// Stored as JSON text to keep the deterministic offline evaluator contract intact.
export const ragBenchmarkTypeDefs = `#graphql
 type RagBenchmarkRun {
  id:Int! label:String! caseCount:Int! answerable:Int! unsupported:Int!
  lectureVersions:[String!]! metrics:String! createdAt:String!
 }
 extend type Query { ragBenchmarkRuns(limit:Int):[RagBenchmarkRun!]! }
 extend type Mutation {
  importRagBenchmark(label:String!,goldJson:String!,predictionsJson:String!):RagBenchmarkRun!
 }
`;
