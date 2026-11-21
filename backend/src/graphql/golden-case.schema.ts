// Golden benchmark CASE bank (reviewed question set), admin-managed. Drafts are
// grounded in a pinned dataset version's own chunks; only APPROVED cases export
// as benchmark truth. See services/golden-case.service.ts and migration 045.
export const goldenCaseTypeDefs = `#graphql
 type GoldenCase {
  id:Int! caseKey:String! lectureId:Int! datasetVersionId:Int!
  question:String! expectedAnswer:String
  expectedChunkIds:[Int!]! sourceChunkIds:[Int!]!
  category:String! answerable:Boolean!
  reviewStatus:String! generationMethod:String!
  reviewedBy:String reviewedAt:String createdAt:String!
 }
 type GoldenDraftSummary {
  datasetVersionId:Int! lectureId:Int! candidateChunks:Int! created:Int! skipped:Int!
 }
 extend type Query {
  goldenBenchmarkCases(datasetVersionId:Int!,status:String,limit:Int):[GoldenCase!]!
  # gold.json (evaluator shape) built from APPROVED cases of a dataset version.
  goldenGoldJson(datasetVersionId:Int!):String!
 }
 extend type Mutation {
  generateGoldenDraftCases(lectureId:Int!,datasetVersionId:Int!):GoldenDraftSummary!
  reviewGoldenCase(id:Int!,status:String!,question:String,category:String,answerable:Boolean,expectedChunkIds:[Int!]):GoldenCase!
  # Hand-written case (e.g. UNSUPPORTED / paraphrase); starts as DRAFT.
  createGoldenCase(lectureId:Int!,datasetVersionId:Int!,question:String!,category:String!,answerable:Boolean!,expectedChunkIds:[Int!],expectedAnswer:String):GoldenCase!
 }
`;
