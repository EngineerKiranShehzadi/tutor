import {gql} from '@apollo/client';

export const GET_GOLDEN_CASES=gql`
 query GoldenBenchmarkCases($datasetVersionId:Int!,$status:String){
  goldenBenchmarkCases(datasetVersionId:$datasetVersionId,status:$status){
   id caseKey lectureId datasetVersionId question category answerable
   reviewStatus expectedChunkIds reviewedBy createdAt
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
 mutation ReviewGoldenCase($id:Int!,$status:String!){
  reviewGoldenCase(id:$id,status:$status){ id reviewStatus reviewedBy }
 }
`;

export const GET_GOLDEN_GOLD_JSON=gql`
 query GoldenGoldJson($datasetVersionId:Int!){ goldenGoldJson(datasetVersionId:$datasetVersionId) }
`;
