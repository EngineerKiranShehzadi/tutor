import {gql} from '@apollo/client';
export const GET_RAG_BENCHMARK_RUNS=gql`
 query RagBenchmarkRuns($limit:Int){ragBenchmarkRuns(limit:$limit){
  id label caseCount answerable unsupported lectureVersions metrics createdAt
 }}
`;
export const IMPORT_RAG_BENCHMARK=gql`
 mutation ImportRagBenchmark($label:String!,$goldJson:String!,$predictionsJson:String!){
  importRagBenchmark(label:$label,goldJson:$goldJson,predictionsJson:$predictionsJson){
   id label caseCount createdAt
  }
 }
`;
