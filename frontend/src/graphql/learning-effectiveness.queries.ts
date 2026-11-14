import {gql} from '@apollo/client';
export const GET_MY_OBSERVED_PROGRESS=gql`
 query MyObservedLearningProgress($courseId:Int!){
  myObservedLearningProgress(courseId:$courseId){
   outcomeId code description eligibleQuizCount firstQuizId latestQuizId
   firstPercent latestPercent changePoints firstSubmittedAt latestSubmittedAt interpretation
  }
 }
`;
