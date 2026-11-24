import {gql} from '@apollo/client';

export const GET_GOLDEN_CASES=gql`
 query GoldenBenchmarkCases($datasetVersionId:Int!,$status:String){
  goldenBenchmarkCases(datasetVersionId:$datasetVersionId,status:$status){
   id caseKey lectureId datasetVersionId question category answerable
   reviewStatus generationMethod expectedChunkIds reviewedBy createdAt
  }
 }
`;

export const GENERATE_GOLDEN_DRAFTS=gql`
 mutation GenerateGoldenDraftCases($lectureId:Int!,$datasetVersionId:Int!){
  generateGoldenDraftCases(lectureId:$lectureId,datasetVersionId:$datasetVersionId){
   datasetVersionId lectureId candidateChunks created skipped
  }
 }
`;

export const REVIEW_GOLDEN_CASE=gql`
 mutation ReviewGoldenCase($id:Int!,$status:String!,$question:String,$category:String,$answerable:Boolean,$expectedChunkIds:[Int!]){
  reviewGoldenCase(id:$id,status:$status,question:$question,category:$category,answerable:$answerable,expectedChunkIds:$expectedChunkIds){
   id reviewStatus question category answerable expectedChunkIds reviewedBy
  }
 }
`;

export const CREATE_GOLDEN_CASE=gql`
 mutation CreateGoldenCase($lectureId:Int!,$datasetVersionId:Int!,$question:String!,$category:String!,$answerable:Boolean!,$expectedChunkIds:[Int!]){
  createGoldenCase(lectureId:$lectureId,datasetVersionId:$datasetVersionId,question:$question,category:$category,answerable:$answerable,expectedChunkIds:$expectedChunkIds){
   id caseKey reviewStatus
  }
 }
`;

export const GET_GOLDEN_GOLD_JSON=gql`
 query GoldenGoldJson($datasetVersionId:Int!){ goldenGoldJson(datasetVersionId:$datasetVersionId) }
`;
